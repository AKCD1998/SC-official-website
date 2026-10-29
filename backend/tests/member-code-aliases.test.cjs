const express = require('express');
const request = require('supertest');

const mockState = {};
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

async function mockQuery(sql, params = []) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  if (text.includes('SELECT sd.id, sd.device_id')) {
    return { rows: params[0] === 'hash:staff' ? [{ id: 'device', device_id: 'counter' }] : [] };
  }
  if (text.startsWith('UPDATE staff_devices SET last_seen_at')) return { rows: [] };
  if (text.includes("to_regclass('public.point_ledger')")) {
    return { rows: [{ points_available: true, pharmacy_available: false }] };
  }
  if (text.startsWith('WITH candidates AS')) {
    if (mockState.aliasError) throw Object.assign(new Error('private schema details'), { code: '42P01' });
    const ids = new Set(mockState.members.filter(m => m.member_code === params[0]).map(m => m.id));
    const aliasId = mockState.aliases.get(params[0]);
    if (mockState.members.some(m => m.id === aliasId)) ids.add(aliasId);
    return { rows: [...ids].slice(0, 2).map(member_id => ({ member_id })) };
  }
  if (text.startsWith('SELECT COALESCE(SUM(amount), 0) AS balance')) {
    return { rows: [{ balance: 17 }] };
  }
  if (text.includes('FROM users u JOIN member_profiles m ON m.user_id = u.id')) {
    if (text.includes('WHERE u.id = $1')) {
      return { rows: mockState.members.filter(m => m.id === params[0]) };
    }
    if (text.includes('WHERE m.member_code = $1')) {
      return { rows: mockState.members.filter(m => m.member_code === params[0]) };
    }
    if (text.includes('WHERE u.phone_number = $1')) {
      return { rows: mockState.members.filter(m => m.phone === params[0]) };
    }
    if (text.includes("WHERE LOWER(COALESCE(u.phone_number, '')) LIKE $1")) {
      const q = params[1];
      return { rows: mockState.members.filter(m => m.is_active &&
        [m.phone, m.full_name, m.email, m.member_code].some(value => String(value || '').toLowerCase().includes(q))) };
    }
  }
  throw Error('Unexpected test query: ' + text);
}

jest.mock('../db', () => ({ query: jest.fn((sql, params) => mockQuery(sql, params)) }));
jest.mock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn() }));
jest.mock('../lib/sccrm', () => ({
  ...jest.requireActual('../lib/sccrm'),
  hashOpaqueToken: value => 'hash:' + value,
}));

const pool = require('../db');
const aliases = require('../lib/memberCodeAliases');
const app = express();
app.use('/api/sccrm', require('../routes/sccrm'));
app.use('/api/members', require('../routes/loyalty'));

function aliasQueries() {
  return pool.query.mock.calls.filter(([sql]) => String(sql).includes('sccrm_member_codes.aliases'));
}
function exact(code, auth = 'staff') {
  return request(app).get('/api/sccrm/customers/search').query({ member_code: code })
    .set('Authorization', 'Bearer ' + auth);
}
function search(code) {
  return request(app).get('/api/members/search').query({ q: code }).set('Authorization', 'Bearer staff');
}

beforeEach(() => {
  delete process.env.SC_OFFICIAL_MEMBER_CODE_ALIASES_ENABLED;
  delete process.env.SC_OFFICIAL_ADA_SYNC_ENABLED;
  mockState.members = [
    { id: A, full_name: 'Member A', phone: '0990000001', email: null,
      member_code: 'AR000-000013', tier: 'bronze', is_active: true, current_points: 17 },
    { id: B, full_name: 'Member B', phone: '0990000002', email: null,
      member_code: 'SCM-22222222', tier: 'bronze', is_active: true, current_points: 0 },
  ];
  mockState.aliases = new Map([['SCM-11111111', A], ['SC-1111111111111111', A]]);
  mockState.aliasError = false;
  pool.query.mockClear();
});
afterEach(() => {
  delete process.env.SC_OFFICIAL_MEMBER_CODE_ALIASES_ENABLED;
  delete process.env.SC_OFFICIAL_ADA_SYNC_ENABLED;
});

test('flag defaults off: canonical SCM and AR codes still work without querying the private schema', async () => {
  expect((await exact('SCM-22222222')).body.customer.id).toBe(B);
  expect((await exact('AR000-000013')).body.customer.id).toBe(A);
  expect((await exact('SCM-11111111')).body.customer).toBeNull();
  expect((await search('Member A')).body.map(m => m.id)).toEqual([A]);
  expect(aliasQueries()).toHaveLength(0);
});

test('only the explicit true flag enables alias queries', async () => {
  process.env.SC_OFFICIAL_MEMBER_CODE_ALIASES_ENABLED = '1';
  expect(await aliases.findMemberIdByCode(pool, 'SCM-11111111')).toBeNull();
  expect(aliasQueries()).toHaveLength(0);
});

test.each(['SCM-11111111', 'SC-1111111111111111', 'AR000-000013', ' ar000-000013 '])(
  'exact staff lookup resolves %s to the same UUID and current display code', async code => {
    process.env.SC_OFFICIAL_MEMBER_CODE_ALIASES_ENABLED = 'true';
    const response = await exact(code);
    expect(response.status).toBe(200);
    expect(response.body.customer).toEqual(expect.objectContaining({
      id: A, member_code: 'AR000-000013', full_name: 'Member A', balance: 17,
    }));
  });

test('unknown and orphaned aliases cannot resolve to a different member', async () => {
  process.env.SC_OFFICIAL_MEMBER_CODE_ALIASES_ENABLED = 'true';
  mockState.aliases.set('SCM-ORPHAN', '33333333-3333-4333-8333-333333333333');
  for (const code of ['SCM-UNKNOWN', 'SCM-ORPHAN']) {
    expect((await exact(code)).body.customer).toBeNull();
  }
});

test('alias and canonical ownership conflict fails closed on both staff searches', async () => {
  process.env.SC_OFFICIAL_MEMBER_CODE_ALIASES_ENABLED = 'true';
  mockState.aliases.set('SCM-22222222', A);
  for (const response of [await exact('SCM-22222222'), await search('SCM-22222222')]) {
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'Member code requires administrator review.' });
    expect(response.body.customer).toBeUndefined();
  }
});

test('a canonical code also registered as its own alias resolves once', async () => {
  process.env.SC_OFFICIAL_MEMBER_CODE_ALIASES_ENABLED = 'true';
  mockState.aliases.set('AR000-000013', A);
  const response = await search('AR000-000013');
  expect(response.status).toBe(200);
  expect(response.body.map(m => m.id)).toEqual([A]);
});

test('POS list search accepts an exact old alias and returns the current AR code once', async () => {
  process.env.SC_OFFICIAL_MEMBER_CODE_ALIASES_ENABLED = 'true';
  const response = await search('scm-11111111');
  expect(response.status).toBe(200);
  expect(response.body).toHaveLength(1);
  expect(response.body[0]).toEqual(expect.objectContaining({ id: A, memberCode: 'AR000-000013' }));
  expect((await search('SCM-1111')).body).toEqual([]);
});

test('POS alias search preserves the active-member filter', async () => {
  process.env.SC_OFFICIAL_MEMBER_CODE_ALIASES_ENABLED = 'true';
  mockState.members[0].is_active = false;
  expect((await search('SCM-11111111')).body).toEqual([]);
});

test('invalid staff credentials never query aliases', async () => {
  process.env.SC_OFFICIAL_MEMBER_CODE_ALIASES_ENABLED = 'true';
  expect((await exact('SCM-11111111', 'revoked')).status).toBe(401);
  expect(aliasQueries()).toHaveLength(0);
});

test('invalid code input does not query aliases', async () => {
  process.env.SC_OFFICIAL_MEMBER_CODE_ALIASES_ENABLED = 'true';
  for (const code of [null, ['AR000-000013'], 'x'.repeat(51), "AR000-000013' OR 1=1", 'Member A']) {
    expect(await aliases.findMemberIdByCode(pool, code)).toBeNull();
  }
  expect(aliasQueries()).toHaveLength(0);
});

test('an enabled but unavailable alias schema fails safely without leaking database details', async () => {
  process.env.SC_OFFICIAL_MEMBER_CODE_ALIASES_ENABLED = 'true';
  mockState.aliasError = true;
  const response = await exact('AR000-000013');
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ error: 'Member code lookup is temporarily unavailable.' });
});
