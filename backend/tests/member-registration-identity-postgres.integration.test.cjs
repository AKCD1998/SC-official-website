'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
let mockPool;
jest.mock('../db', () => ({ query: (...args) => mockPool.query(...args), connect: () => mockPool.connect() }));
jest.mock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn() }));
const identity = require('../lib/memberRegistrationIdentity');
const { provisionMemberRegistrationReporting } = require('../scripts/provision-member-registration-reporting.cjs');
const run = process.env.SCCRM_IDENTITY_TEST_DATABASE_URL;
const describeDb = run ? describe : describe.skip;
const staff = { id: crypto.randomUUID() }, otherStaff = { id: crypto.randomUUID() };
const token = 'synthetic-registration-review-device';
const source = 'hq000/AdaAcc';
const migration = '../supabase/migrations/20261110091654_member_registration_confirmation.sql';

describeDb('cashier confirmation with disposable PostgreSQL and real API routes', () => {
  let app, original, sequence = 0;
  const oldEnv = { ...process.env };
  const sqlFile = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
  const body = phone => ({ name: 'Synthetic New Person', phone, requestId: crypto.randomUUID() });
  const api = (route, data) => request(app).post('/api/members/' + route).set('Authorization', 'Bearer ' + token).send(data);
  const choice = (draft, options, action, candidateId = null) => ({ ...draft, registrationDecision: {
    requestId: draft.requestId, reviewToken: options.reviewToken, action, candidateId,
  } });
  async function member(phone, name = 'Synthetic Existing', active = true) {
    const id = crypto.randomUUID();
    await mockPool.query('INSERT INTO users(id,full_name,phone_number) VALUES($1,$2,$3)', [id, name, phone]);
    await mockPool.query('INSERT INTO member_profiles(user_id,member_code,is_active) VALUES($1,$2,$3)',
      [id, 'SCM-' + id.replaceAll('-', '').slice(0, 8).toUpperCase(), active]);
    return id;
  }
  async function ada(phone, name = 'Synthetic Ada') {
    const code = 'AR003-' + String(++sequence).padStart(6, '0');
    const payload = { FTCstCode: code, FTCstName: name, FTCstTel: phone, FTCstBusiness: '1' };
    return (await mockPool.query(`INSERT INTO ada_history.customers
      (source_id,ada_code,name,phone,active,source_payload,payload_hash,source_snapshot)
      VALUES($1,$2,$3,$4,'1',$5,$6,$7) RETURNING directory_id,ada_code`,
    [source, code, name, phone, payload, crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'), crypto.randomUUID()])).rows[0];
  }
  async function snapshot() {
    return (await mockPool.query(`SELECT source_id,ada_code,name,phone,source_payload,payload_hash FROM ada_history.customers ORDER BY ada_code`)).rows;
  }
  beforeAll(async () => {
    const url = new URL(run);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !/^\/crm_registration_test_/.test(url.pathname)) throw Error('Disposable local registration database required');
    mockPool = new Pool({ connectionString: run, ssl: false });
    if (!(await mockPool.query("SELECT to_regclass('public.users') IS NULL AS empty")).rows[0].empty) throw Error('Empty database required');
    await mockPool.query(sqlFile('../migrations/202610200001_crm_counter_bootstrap.sql'));
    await mockPool.query(sqlFile('../migrations/loyalty_cashier_claims.sql'));
    await mockPool.query(sqlFile('../sql/ada-member-mirror.sql'));
    // Exercise the exact older owned enum upgrade as well as a second apply.
    await mockPool.query(`CREATE SCHEMA sccrm_member_codes;
      CREATE TABLE sccrm_member_codes.meta(singleton boolean,marker uuid,scope text,schema_version integer);
      INSERT INTO sccrm_member_codes.meta VALUES(true,'cffb05d6-116a-458d-98ba-52473745c116','SCCRM-HQ-MEMBER-CODE-AUTHORITY-V1',1);
      CREATE TABLE sccrm_member_codes.assignments(kind text CHECK(kind IN('hq_create','approved_existing')),ada_code text);
      INSERT INTO sccrm_member_codes.assignments VALUES('hq_create','AR000-000001');`);
    const client = await mockPool.connect();
    try { await provisionMemberRegistrationReporting(client, { apply: true, activate: true }); } finally { client.release(); }
    await mockPool.query(sqlFile(migration));
    // Re-applying an additive migration must preserve every record.
    await mockPool.query(sqlFile(migration));
    Object.assign(process.env, { SCCRM_REFRESH_TOKEN_SECRET: 'synthetic-review-secret',
      SC_OFFICIAL_ADA_SYNC_ENABLED: 'true', SC_OFFICIAL_ADA_POINTS_MODE: 'off',
      SC_OFFICIAL_MEMBER_CODE_ALIASES_ENABLED: 'false', SC_OFFICIAL_MEMBER_REGISTRATION_CONFIRMATION_ENABLED: 'true' });
    await mockPool.query("INSERT INTO branches(id,name,code) VALUES($1,'Synthetic 003','003')", [staff.id]);
    for (const [index, device] of [staff, otherStaff].entries()) await mockPool.query(
      'INSERT INTO staff_devices(id,device_id,device_name,token_hash,branch_id) VALUES($1,$2,$3,$4,$5)',
      [device.id, 'fixture-' + index, 'Synthetic Counter', require('../lib/sccrm').hashOpaqueToken(index ? token + '-other' : token), staff.id]);
    app = express(); app.use(express.json()); app.use('/api/members', require('../routes/loyalty'));
    await ada('0997000000', 'Unrelated Ada Customer');
    original = await snapshot();
  });
  afterAll(async () => {
    if (mockPool) await mockPool.end();
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
  });

  test('options are staff-only, never save a member, and reject invalid Thai mobiles', async () => {
    expect((await request(app).post('/api/members/registration-options').send(body('0997000001'))).status).toBe(401);
    for (const phone of ['081234567', '0111111111', '021234567', '08123456789']) {
      expect((await api('registration-options', body(phone))).status).toBe(400);
    }
    const draft = body('0997000001');
    const result = await api('registration-options', draft);
    expect(result.status).toBe(200); expect(result.body.candidates).toEqual([]);
    expect((await mockPool.query('SELECT count(*)::int n FROM users')).rows[0].n).toBe(0);
    expect((await mockPool.query('SELECT count(*)::int n FROM sccrm_registration.confirmations')).rows[0].n).toBe(0);
  });
  test('new signup and concurrent lost-response retries save once and retain authenticated branch', async () => {
    const draft = body('0997000002'), options = (await api('registration-options', draft)).body;
    const replies = await Promise.all(Array.from({ length: 3 }, () => api('registrations/confirm', choice(draft, options, 'new'))));
    expect(replies.map(r => r.status).sort()).toEqual([200, 200, 201]);
    expect(new Set(replies.map(r => r.body.id)).size).toBe(1);
    const id = replies[0].body.id;
    expect((await mockPool.query('SELECT branch_code FROM crm_reporting.member_registrations WHERE member_id=$1', [id])).rows).toEqual([{ branch_code: '003' }]);
    const saved = await api('registration-options', draft);
    expect(saved.body.completedMemberId).toBe(id); expect(saved.body.completedAction).toBe('new');
    expect((await mockPool.query('SELECT count(*)::int n FROM sccrm_registration.confirmations WHERE request_id=$1', [draft.requestId])).rows[0].n).toBe(1);
  });
  test('same phone always offers a choice even when the names are different; using old member never overwrites it', async () => {
    const id = await member('0997000003'), draft = body('0997000003');
    const before = (await mockPool.query('SELECT to_jsonb(u) row FROM users u WHERE id=$1', [id])).rows[0];
    const options = (await api('registration-options', draft)).body;
    expect(options.candidates).toEqual([expect.objectContaining({ id: 'member:' + id, name: 'Synthetic Existing', phone: draft.phone, canUseExisting: true })]);
    const result = await api('registrations/confirm', choice(draft, options, 'existing', options.candidates[0].id));
    expect(result.status).toBe(200); expect(result.body.id).toBe(id);
    expect((await mockPool.query('SELECT to_jsonb(u) row FROM users u WHERE id=$1', [id])).rows[0]).toEqual(before);
  });
  test('different person keeps a separate identity with shared contact phone, searchable and editable without stealing the account phone', async () => {
    const oldId = await member('0997000004'), draft = body('0997000004');
    const options = (await api('registration-options', draft)).body;
    const result = await api('registrations/confirm', choice(draft, options, 'new'));
    expect(result.status).toBe(201); expect(result.body.id).not.toBe(oldId); expect(result.body.phone).toBe(draft.phone);
    const stored = (await mockPool.query('SELECT u.phone_number,m.contact_phone FROM users u JOIN member_profiles m ON m.user_id=u.id WHERE u.id=$1', [result.body.id])).rows[0];
    expect(stored).toEqual({ phone_number: null, contact_phone: draft.phone });
    const search = await request(app).get('/api/members/search?q=' + draft.phone).set('Authorization', 'Bearer ' + token);
    expect(search.status).toBe(200); expect(new Set(search.body.map(row => row.id))).toEqual(new Set([oldId, result.body.id]));
    const edit = await request(app).put('/api/members/' + result.body.id).set('Authorization', 'Bearer ' + token).send({ name: 'Synthetic Second Edited', phone: '0997000099' });
    expect(edit.status).toBe(200); expect(edit.body.phone).toBe('0997000099');
    expect((await mockPool.query('SELECT phone_number FROM users WHERE id=$1', [oldId])).rows[0].phone_number).toBe(draft.phone);
    expect((await mockPool.query('SELECT allow_shared_contact,profile_hash FROM sccrm_registration.confirmations WHERE member_id=$1', [result.body.id])).rows[0])
      .toEqual({ allow_shared_contact: true, profile_hash: crypto.createHash('sha256').update(JSON.stringify({ email: null, name: draft.name, phone: draft.phone })).digest('hex') });
  });
  test('choosing an unlinked Ada customer binds that exact code and preserves its purchase owner and data', async () => {
    const a = await ada('0997000005'), draft = body('0997000005');
    const before = await snapshot(), receiptKey = '1'.repeat(64);
    await mockPool.query(`INSERT INTO ada_history.receipts(source_id,receipt_key,branch_code,pos_code,doc_no,doc_type,customer_code,source_payload,payload_hash,source_snapshot)
      VALUES($1,$2,'003','002','SYNTHETIC-HISTORY-1','1',$3,'{}',$2,$4)`, [source, receiptKey, a.ada_code, crypto.randomUUID()]);
    const options = (await api('registration-options', draft)).body;
    expect(options.candidates[0].memberCode).toBe(a.ada_code);
    const result = await api('registrations/confirm', choice(draft, options, 'existing', options.candidates[0].id));
    expect(result.status).toBe(200); expect(result.body.memberCode).toBe(a.ada_code);
    expect((await mockPool.query("SELECT user_id FROM ada_history.purchase_claims WHERE receipt_no='SYNTHETIC-HISTORY-1'")).rows).toEqual([{ user_id: result.body.id }]);
    expect(await snapshot()).toEqual(before);
  });
  test('explicit choice pairs a pending exact-name signup to Ada, keeps its ID and previous code, and clears the old review', async () => {
    const draft = body('0997000006'), id = await member(draft.phone, draft.name), a = await ada(draft.phone, 'Synthetic Short Name');
    const previous = (await mockPool.query('SELECT member_code FROM member_profiles WHERE user_id=$1', [id])).rows[0].member_code;
    await mockPool.query("INSERT INTO ada_history.outbound_state(member_id,profile_hash,state,last_code) VALUES($1,$2,'review','EXISTING_CUSTOMER_REVIEW_REQUIRED')", [id, 'a'.repeat(64)]);
    const options = (await api('registration-options', draft)).body;
    expect(options.candidates).toHaveLength(1);
    const result = await api('registrations/confirm', choice(draft, options, 'existing', options.candidates[0].id));
    expect(result.status).toBe(200); expect(result.body.id).toBe(id); expect(result.body.memberCode).toBe(a.ada_code);
    expect((await mockPool.query('SELECT previous_code FROM sccrm_registration.confirmations WHERE request_id=$1', [draft.requestId])).rows[0].previous_code).toBe(previous);
    expect((await mockPool.query('SELECT state,last_code FROM ada_history.outbound_state WHERE member_id=$1', [id])).rows[0]).toEqual({ state: 'created', last_code: null });
  });
  test('multiple same-phone members are listed separately; no automatic pick or merge', async () => {
    await member('0997000007'); await ada('0997000007', 'Synthetic Other Ada'); await ada('0997000007', 'Synthetic Company');
    const options = (await api('registration-options', body('0997000007'))).body;
    expect(options.candidates).toHaveLength(3); expect(new Set(options.candidates.map(c => c.id)).size).toBe(3);
  });
  test('formatted shared Ada phones match exactly, including international format, with no substring false match', async () => {
    await ada('081-234-5678 / +66 89 700 0008', 'Synthetic Multi Contact');
    await ada('10997000008', 'Synthetic Substring');
    const options = (await api('registration-options', body('0897000008'))).body;
    expect(options.candidates.map(c => c.name)).toEqual(['Synthetic Multi Contact']);
    await ada('66 89 700 0020', 'Synthetic Single International');
    const single = (await api('registration-options', body('0897000020'))).body;
    expect(single.candidates.map(c => c.name)).toEqual(['Synthetic Single International']);
  });
  test('inactive matches are shown but cannot be selected as active accounts', async () => {
    await member('0997000009', 'Synthetic Closed', false);
    const draft = body('0997000009'), options = (await api('registration-options', draft)).body;
    expect(options.candidates[0].canUseExisting).toBe(false);
    expect((await api('registrations/confirm', choice(draft, options, 'existing', options.candidates[0].id))).status).toBe(409);
  });
  test('stale names, expired review, edited draft, tampered token and other-device token cannot approve a member', async () => {
    const id = await member('0997000010'), draft = body('0997000010');
    const options = (await api('registration-options', draft)).body;
    const decision = choice(draft, options, 'existing', options.candidates[0].id);
    expect((await api('registrations/confirm', { ...decision, name: 'Changed Draft' })).status).toBe(409);
    const bad = structuredClone(decision); bad.registrationDecision.reviewToken += 'x';
    expect((await api('registrations/confirm', bad)).status).toBe(400);
    await expect(identity.confirm(mockPool, decision, otherStaff, () => { throw Error('must not create'); })).rejects.toMatchObject({ status: 409 });
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000);
    try { await expect(identity.confirm(mockPool, decision, staff, () => {})).rejects.toMatchObject({ status: 409 }); } finally { clock.mockRestore(); }
    await mockPool.query("UPDATE users SET full_name='Changed Existing' WHERE id=$1", [id]);
    expect((await api('registrations/confirm', decision)).status).toBe(409);
    expect((await mockPool.query('SELECT count(*)::int n FROM sccrm_registration.confirmations WHERE request_id=$1', [draft.requestId])).rows[0].n).toBe(0);
  });
  test('existing conflicting bill owner refuses the link and rolls back any partial public member', async () => {
    const a = await ada('0997000011'), draft = body('0997000011'), other = await member('0997000012');
    await mockPool.query(`INSERT INTO ada_history.receipts(source_id,receipt_key,branch_code,pos_code,doc_no,doc_type,customer_code,source_payload,payload_hash,source_snapshot)
      VALUES($1,$2,'003','002','SYNTHETIC-CONFLICT','1',$3,'{}',$2,$4)`, [source, '2'.repeat(64), a.ada_code, crypto.randomUUID()]);
    await mockPool.query("INSERT INTO loyalty_claims(id,branch_code,receipt_no,total_amount,user_id) VALUES('synthetic-conflict','003','SYNTHETIC-CONFLICT',10,$1)", [other]);
    const options = (await api('registration-options', draft)).body;
    const result = await api('registrations/confirm', choice(draft, options, 'existing', options.candidates[0].id));
    expect(result.status).toBe(409); expect(result.body.code).toBe('BILL_OWNER_CONFLICT');
    expect((await mockPool.query('SELECT id FROM users WHERE id=$1', [a.directory_id])).rows).toEqual([]);
    expect((await mockPool.query('SELECT member_id FROM ada_history.member_links WHERE source_id=$1 AND ada_code=$2', [source, a.ada_code])).rows).toEqual([]);
  });
  test('database unique account-phone rule and private audit survive; unrelated Ada customer never changes', async () => {
    expect((await snapshot()).find(row => row.ada_code === original[0].ada_code)).toEqual(original[0]);
    expect((await mockPool.query("SELECT indexname FROM pg_indexes WHERE indexname='crm_counter_users_phone_unique'")).rows).toHaveLength(1);
    expect((await mockPool.query("SELECT relrowsecurity FROM pg_class WHERE oid='sccrm_registration.confirmations'::regclass")).rows[0].relrowsecurity).toBe(true);
    expect((await mockPool.query("SELECT nspacl::text acl FROM pg_namespace WHERE nspname='sccrm_registration'")).rows[0].acl).not.toMatch(/\{=|,=/);
    await mockPool.query("INSERT INTO sccrm_member_codes.assignments(kind,ada_code) VALUES('hq_create_distinct','AR000-000002')");
    expect((await mockPool.query('SELECT kind,ada_code FROM sccrm_member_codes.assignments ORDER BY ada_code')).rows)
      .toEqual([{ kind: 'hq_create', ada_code: 'AR000-000001' }, { kind: 'hq_create_distinct', ada_code: 'AR000-000002' }]);
    await expect(mockPool.query("INSERT INTO sccrm_member_codes.assignments(kind,ada_code) VALUES('hq_create_distinct','AR003-000002')")).rejects.toMatchObject({ code: '23514' });
  });
});
