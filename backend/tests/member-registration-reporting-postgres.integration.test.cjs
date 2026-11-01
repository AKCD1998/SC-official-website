const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
let mockPool;
jest.mock('../db', () => ({ query: (...args) => mockPool.query(...args), connect: () => mockPool.connect() }));
jest.mock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn() }));
const { provisionMemberRegistrationReporting } = require('../scripts/provision-member-registration-reporting.cjs');
const { recordMemberRegistration, registrationCounts } = require('../lib/memberRegistrations');
const run = process.env.SCCRM_REGISTRATION_TEST_DATABASE_URL;
const describeDb = run ? describe : describe.skip;
const ids = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const staffToken = 'registration-fixture-staff-token';
const sample = { name: 'Synthetic Signup', fullName: 'Synthetic Signup', phone: '0990000011', dob: '1990-01-01', consents: { pdpa_general: true } };

describeDb('new-member reporting with real PostgreSQL and registration routes', () => {
  let app;
  const previousSecret = process.env.SCCRM_REFRESH_TOKEN_SECRET;
  const previousInternalToken = process.env.SCCRM_INTERNAL_API_TOKEN;
  beforeAll(async () => {
    const url = new URL(run);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !/^\/crm_registration_test_/.test(url.pathname)) throw Error('Local disposable registration database required');
    process.env.SCCRM_REFRESH_TOKEN_SECRET = 'synthetic-registration-fixture-secret';
    mockPool = new Pool({ connectionString: run, ssl: false });
    if (!(await mockPool.query("SELECT to_regclass('public.users') IS NULL AS empty")).rows[0].empty) throw Error('Database must be empty');
    await mockPool.query(fs.readFileSync(path.join(__dirname, '../migrations/202610200001_crm_counter_bootstrap.sql'), 'utf8'));
    const client = await mockPool.connect();
    try {
      expect((await provisionMemberRegistrationReporting(client)).status).toBe('dry-run-rolled-back');
      expect((await client.query("SELECT to_regclass('crm_reporting.member_registrations') AS table")).rows[0].table).toBeNull();
      await provisionMemberRegistrationReporting(client, { apply: true, activate: true });
      await provisionMemberRegistrationReporting(client, { apply: true, activate: true });
    } finally { client.release(); }
    await mockPool.query("UPDATE crm_reporting.registration_tracking SET tracking_started_at='2026-11-01T00:00:00+07:00'");
    await mockPool.query('INSERT INTO branches(id,name,code) VALUES($1,$2,$3)', [ids(1), 'Fixture Branch', '004']);
    await mockPool.query('INSERT INTO staff_devices(id,device_id,device_name,token_hash,branch_id) VALUES($1,$2,$3,$4,$5)',
      [ids(2), 'test-device', 'Test Counter', require('../lib/sccrm').hashOpaqueToken(staffToken), ids(1)]);
    process.env.SCCRM_INTERNAL_API_TOKEN = 'registration-internal-fixture';
    app = express(); app.use(express.json());
    app.use('/api/members', require('../routes/loyalty'));
    app.use('/api/crm', require('../routes/crmMembers'));
    app.use('/api/sccrm', require('../routes/sccrm'));
    app.use('/internal', require('../routes/sccrmInternal'));
    app.use('/join', require('../routes/publicMemberRegistration').createPublicMemberRegistration({ pool: mockPool, maxRequests: 1000 }));
  });
  afterAll(async () => {
    if (mockPool) await mockPool.end();
    if (previousSecret === undefined) delete process.env.SCCRM_REFRESH_TOKEN_SECRET; else process.env.SCCRM_REFRESH_TOKEN_SECRET = previousSecret;
    if (previousInternalToken === undefined) delete process.env.SCCRM_INTERNAL_API_TOKEN; else process.env.SCCRM_INTERNAL_API_TOKEN = previousInternalToken;
  });
  const signup = (route, body = sample) => request(app).post(route).set('Authorization', `Bearer ${staffToken}`).send(body);

  test.each([['/api/members', 'pos', '0990000011'], ['/api/crm/members', 'counter', '0990000012'], ['/api/sccrm/customers', 'staff', '0990000013']])
  ('%s captures the authenticated branch, not an untrusted body branch, atomically and once', async (route, source, phone) => {
    const result = await signup(route, { ...sample, phone, branchCode: '001' });
    expect(result.status).toBe(201);
    const { rows } = await mockPool.query(`SELECT r.source,r.branch_code,r.device_id FROM crm_reporting.member_registrations r JOIN users u ON u.id=r.member_id WHERE u.phone_number=$1`, [phone]);
    expect(rows).toEqual([{ source, branch_code: '004', device_id: 'test-device' }]);
    expect((await signup(route, { ...sample, phone })).status).toBe(409);
    expect((await mockPool.query('SELECT count(*)::int AS n FROM crm_reporting.member_registrations WHERE source=$1', [source])).rows[0].n).toBe(1);
  });
  test('QR selects a valid branch; old clients remain unassigned; retries never count twice', async () => {
    const qr = { firstName: 'Synthetic', lastName: 'QR', phone: '0990000014', consent: true, branchCode: '005' };
    const send = body => request(app).post('/join/submit').send(body);
    expect((await send(qr)).status).toBe(200); expect((await send(qr)).status).toBe(200);
    expect((await send({ ...qr, branchCode: undefined, phone: '0990000015' })).status).toBe(200);
    expect((await send({ ...qr, branchCode: '999', phone: '0990000016' })).status).toBe(400);
    const { rows } = await mockPool.query("SELECT branch_code FROM crm_reporting.member_registrations WHERE source='qr' ORDER BY branch_code NULLS LAST");
    expect(rows).toEqual([{ branch_code: '005' }, { branch_code: null }]);
  });
  test('event-storage failure rolls back the complete signup', async () => {
    await mockPool.query("ALTER TABLE crm_reporting.member_registrations ADD CONSTRAINT fixture_no_pos CHECK(source<>'pos') NOT VALID");
    try {
      expect((await signup('/api/members', { ...sample, phone: '0990000017' })).status).toBe(500);
      expect((await mockPool.query("SELECT count(*)::int n FROM users WHERE phone_number='0990000017'")).rows[0].n).toBe(0);
    } finally { await mockPool.query('ALTER TABLE crm_reporting.member_registrations DROP CONSTRAINT fixture_no_pos'); }
  });
  test('Thai midnight/month boundaries, as-of cutoff, duplicate-event protection and legacy exclusion', async () => {
    await mockPool.query('DELETE FROM crm_reporting.member_registrations');
    const dates = ['2026-10-31T16:59:59Z', '2026-10-31T17:00:00Z', '2026-11-01T16:59:59Z', '2026-11-01T17:00:00Z', '2026-11-30T16:59:59Z', '2026-11-30T17:00:00Z'];
    for (let n = 0; n < dates.length; n++) {
      await recordMemberRegistration(mockPool, { memberId: ids(100 + n), source: 'pos', branchCode: '001' });
      await mockPool.query('UPDATE crm_reporting.member_registrations SET registered_at=$1 WHERE member_id=$2', [dates[n], ids(100 + n)]);
    }
    await recordMemberRegistration(mockPool, { memberId: ids(101), source: 'qr', branchCode: '005' });
    // The users/profiles made in the earlier tests remain present, but no
    // registration event means they contribute nothing to this report.
    const result = await registrationCounts(mockPool, { month: '2026-11' }, new Date('2026-12-01T00:00:00Z'));
    expect(result.counts).toEqual([{ date: '2026-11-01', branchCode: '001', count: 2 }, { date: '2026-11-02', branchCode: '001', count: 1 }, { date: '2026-11-30', branchCode: '001', count: 1 }]);
    const early = await registrationCounts(mockPool, { month: '2026-11' }, new Date('2026-11-01T16:59:59Z'));
    expect(early.counts).toEqual([{ date: '2026-11-01', branchCode: '001', count: 2 }]);
  });
  test('aggregate endpoint requires internal auth and returns no member or device data', async () => {
    expect((await request(app).get('/internal/crm/member-registrations?month=2026-11')).status).toBe(401);
    const result = await request(app).get('/internal/crm/member-registrations?month=2026-11').set('x-internal-token', 'registration-internal-fixture');
    expect(result.status).toBe(200); expect(result.headers['cache-control']).toContain('no-store');
    expect(Object.keys(result.body).sort()).toEqual(['ok','month','timeZone','generatedAt','trackingStartedAt','counts'].sort());
    expect(JSON.stringify(result.body)).not.toMatch(/test-device|099000|member_id/);
    expect((await request(app).get('/internal/crm/member-registrations?month=2026-10').set('x-internal-token', 'registration-internal-fixture')).status).toBe(400);
  });
  test('private reporting tables have RLS and no public schema privileges', async () => {
    const { rows } = await mockPool.query("SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='crm_reporting' AND relkind='r'");
    expect(rows).toHaveLength(2); expect(rows.every(r => r.relrowsecurity)).toBe(true);
    expect((await mockPool.query("SELECT nspacl::text acl FROM pg_namespace WHERE nspname='crm_reporting'")).rows[0].acl).not.toMatch(/\{=|,=/);
  });
});
