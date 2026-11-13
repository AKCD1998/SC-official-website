const authority = require('../lib/adaPointAuthority');

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const code = 'AR001-000001';
const now = new Date('2026-11-02T05:00:00.000Z');
const ready = (overrides = {}) => ({
  ada_code: code, member_id: id, canonical_code: code, mapped_code: code, cache_code: code,
  balance_exact: '12.5000', observed_at: now, state: 'ready', ...overrides,
});
const profile = (overrides = {}) => ready({resolved_code:code,...overrides});
const nativeEvent = (overrides = {}) => ({event_key:'a'.repeat(64),ada_code:code,card_type:'1',points_exact:'3',
  state:'ready',active:true,owner_member_id:id,...overrides});
const database = rows => ({ query: jest.fn(async () => ({ rows })) });

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(now);
  process.env.SC_OFFICIAL_ADA_POINTS_MODE = 'ada-primary';
  delete process.env.SC_OFFICIAL_ADA_POINTS_MAX_AGE_SECONDS;
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.SC_OFFICIAL_ADA_POINTS_MODE;
  delete process.env.SC_OFFICIAL_ADA_POINTS_MAX_AGE_SECONDS;
});

test.each([undefined, '', 'off'])('mode %s disables every reader without touching storage', async mode => {
  if (mode === undefined) delete process.env.SC_OFFICIAL_ADA_POINTS_MODE;
  else process.env.SC_OFFICIAL_ADA_POINTS_MODE = mode;
  const db = database([ready()]);
  expect(authority.enabled()).toBe(false);
  expect(await authority.readCodeBalance(db, code)).toMatchObject({ available: false, reason: 'disabled', balance: null });
  expect(await authority.readMemberBalance(db, id)).toMatchObject({ available: false, reason: 'disabled' });
  expect(db.query).not.toHaveBeenCalled();
});

test.each(['true', 'false', 'ADA-PRIMARY', 'ada', ' ada-primary ', '1'])('invalid mode %s fails closed', mode => {
  process.env.SC_OFFICIAL_ADA_POINTS_MODE = mode;
  expect(() => authority.enabled()).toThrow('configuration is invalid');
});

test.each(['0', '4', '3601', '-1', 'NaN', 'Infinity', '1e2', '5.5', ' 120 '])('invalid maximum age %s is a configuration error', value => {
  process.env.SC_OFFICIAL_ADA_POINTS_MAX_AGE_SECONDS = value;
  expect(() => authority.enabled()).toThrow('configuration is invalid');
});

test('a real zero remains distinguishable from unknown storage', async () => {
  const db = database([ready({ balance_exact: '0.000' })]);
  expect(await authority.readCodeBalance(db, code)).toEqual({
    available: true, balanceExact: '0.000', balance: 0, observedAt: now.toISOString(),
  });
  const missing = await authority.readCodeBalance(database([]), code);
  expect(missing).toEqual({ available: false, reason: 'unknown', balanceExact: null, balance: null, observedAt: null });
});

test.each([
  ['12.5000', 12.5], ['-1.2500', -1.25], ['0.1', 0.1], ['0.0000001', 1e-7],
  ['9007199254740991', Number.MAX_SAFE_INTEGER], ['-0.00', 0],
  ['9007199254740992', null], ['12.500000000000000001', null],
  ['0.1000000000000000001', null], ['9999999999999999999999999999.1', null],
])('preserves %s exactly and returns a Number only after a safe decimal round trip', async (exact, numeric) => {
  const result = await authority.readCodeBalance(database([ready({ balance_exact: exact })]), code);
  expect(result).toMatchObject({ available: true, balanceExact: exact, balance: numeric });
});

test.each([null, '', 'NaN', 'Infinity', '-Infinity', '1e2', '12pts', 12.5])('invalid cache balance %s does not become zero', async value => {
  expect(await authority.readCodeBalance(database([ready({ balance_exact: value })]), code))
    .toMatchObject({ available: false, reason: 'source_unavailable', balance: null, balanceExact: null });
});

test('the 120-second freshness boundary is inclusive and older data is not returned', async () => {
  const boundary = ready({ observed_at: new Date(now.getTime() - 120000) });
  expect((await authority.readCodeBalance(database([boundary]), code)).available).toBe(true);
  const stale = await authority.readCodeBalance(database([ready({ observed_at: new Date(now.getTime() - 120001) })]), code);
  expect(stale).toMatchObject({ available: false, reason: 'stale', balance: null, balanceExact: null });
  expect(stale.observedAt).toBe('2026-11-02T04:57:59.999Z');
});

test.each(['5', '3600'])('configured maximum age %s controls freshness', async value => {
  process.env.SC_OFFICIAL_ADA_POINTS_MAX_AGE_SECONDS = value;
  const age = Number(value) * 1000;
  expect((await authority.readCodeBalance(database([ready({ observed_at: new Date(now.getTime() - age) })]), code)).available).toBe(true);
  expect((await authority.readCodeBalance(database([ready({ observed_at: new Date(now.getTime() - age - 1) })]), code)).reason).toBe('stale');
});

test.each([
  { state: 'pending' }, { state: 'error' }, { state: null }, { observed_at: null },
  { observed_at: 'not-a-date' }, { observed_at: new Date(now.getTime() + 5001) },
])('not-ready or invalid source observations remain unavailable: %j', async overrides => {
  expect(await authority.readCodeBalance(database([ready(overrides)]), code))
    .toMatchObject({ available: false, reason: 'source_unavailable', balance: null });
});

test('database errors are sanitized and never expose a legacy balance', async () => {
  const db = { query: jest.fn(async () => { throw Error('sensitive database connection detail'); }) };
  const direct = await authority.readCodeBalance(db, code);
  const batch = await authority.readMemberBalances(db, [id, other]);
  expect(JSON.stringify(direct)).not.toContain('sensitive');
  expect(direct).toMatchObject({ available: false, reason: 'source_unavailable', balance: null });
  expect([...batch.values()].every(r => !r.available && r.reason === 'source_unavailable' && r.balance === null)).toBe(true);
});

test('an unmaterialized Ada contact can be read directly without reading a user or alias', async () => {
  const nativeCode = 'S2203001002-0010843';
  const db = database([ready({ ada_code: nativeCode })]);
  expect((await authority.readCodeBalance(db, nativeCode)).balance).toBe(12.5);
  expect(db.query.mock.calls[0][1]).toEqual([nativeCode]);
  expect(db.query.mock.calls[0][0]).not.toMatch(/member_profiles|member_links|users|point_ledger/i);
});

test('batch lookup uses one query, deduplicates UUIDs and ignores unrequested identities', async () => {
  const upper = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  const lower = upper.toLowerCase();
  const db = database([
    ready(), ready({ member_id: lower, balance_exact: '20' }),
    ready({ member_id: other, balance_exact: '900' }),
  ]);
  const result = await authority.readMemberBalances(db, [id, upper, lower]);
  expect(db.query).toHaveBeenCalledTimes(1);
  expect(db.query.mock.calls[0][1]).toEqual([[id, lower]]);
  expect([...result.keys()]).toEqual([id, lower]);
  expect(result.get(id).balance).toBe(12.5);
  expect(result.get(lower).balance).toBe(20);
});

test.each([
  { canonical_code: 'SCM-11111111', mapped_code: code, cache_code: code },
  { canonical_code: 'ADA-' + code, mapped_code: code, cache_code: code },
  { mapped_code: 'AR001-000002', cache_code: 'AR001-000002' },
  { mapped_code: null, cache_code: null }, { cache_code: null },
])('a noncanonical, unapproved or missing mapping does not inherit an alias balance: %j', async overrides => {
  expect(await authority.readMemberBalance(database([ready(overrides)]), id))
    .toMatchObject({ available: false, reason: 'unknown', balance: null });
});

test('the member query binds the current canonical code to the exact HQ mapping without summing aliases', async () => {
  const db = database([ready()]);
  expect((await authority.readMemberBalance(db, id)).balanceExact).toBe('12.5000');
  const sql = db.query.mock.calls[0][0];
  expect(sql).toContain("l.source_id = 'hq000/AdaAcc'");
  expect(sql).toContain('l.ada_code = m.member_code');
  expect(sql).toContain("m.member_code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$'");
  expect(sql).not.toMatch(/\bSUM\s*\(|point_ledger|full_name|phone|token|password|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
});

test.each(['0.0000','8.0000','-9.0000'])('an approved native legacy canonical code preserves Ada balance %s',async exact=>{
  const legacy='S2203001002-0010843';
  const db=database([ready({canonical_code:legacy,mapped_code:legacy,cache_code:legacy,balance_exact:exact})]);
  expect(await authority.readMemberBalance(db,id)).toMatchObject({available:true,balanceExact:exact,balance:Number(exact)});
  expect(await authority.readProfileBalance(database([profile({resolved_code:legacy,cache_code:legacy,balance_exact:exact})]),id))
    .toMatchObject({available:true,balanceExact:exact,balance:Number(exact)});
});

test('conflicting duplicate cache results are unavailable rather than summed or last-row-wins', async () => {
  expect(await authority.readCodeBalance(database([ready(), ready({ balance_exact: '30' })]), code))
    .toMatchObject({ available: false, reason: 'source_unavailable' });
  const result = await authority.readMemberBalances(database([ready(), ready({ balance_exact: '30' })]), [id]);
  expect(result.get(id)).toMatchObject({ available: false, reason: 'source_unavailable', balance: null });
});

test('invalid identifiers and more than 100 inputs fail before querying', async () => {
  const db = database([]);
  for (const value of ["AR001-000001'; SELECT 1--", '', 'a'.repeat(21), '../code', null]) {
    await expect(authority.readCodeBalance(db, value)).rejects.toMatchObject({ code: 'INVALID_ADA_CODE', status: 400 });
  }
  for (const values of [["'; SELECT 1--"], [null], null, 'not-an-array', Array(101).fill(id)]) {
    await expect(authority.readMemberBalances(db, values)).rejects.toMatchObject({ code: 'INVALID_MEMBER_IDS', status: 400 });
  }
  expect(db.query).not.toHaveBeenCalled();
});

test('an empty batch needs no query and exactly 100 valid IDs use one bounded query', async () => {
  const db = database([]);
  expect((await authority.readMemberBalances(db, [])).size).toBe(0);
  expect(db.query).not.toHaveBeenCalled();
  const ids = Array.from({ length: 100 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const result = await authority.readMemberBalances(db, ids);
  expect(result.size).toBe(100);
  expect(db.query).toHaveBeenCalledTimes(1);
  expect([...result.values()].every(r => !r.available && r.reason === 'unknown')).toBe(true);
});

test('the legacy profile reader requires a DB-owned code and exact approved link or unlinked directory identity',async()=>{
  const db=database([profile()]);
  expect((await authority.readProfileBalance(db,id)).balance).toBe(12.5);
  const sql=db.query.mock.calls[0][0];
  expect(sql).toContain("WHEN left(m.member_code,4) = 'ADA-' THEN substring(m.member_code from 5)");
  expect(sql).toContain('l.member_id = r.member_id');
  expect(sql).toContain('m.user_id IS NULL');
  expect(sql).toContain('NOT EXISTS');
  expect(sql).not.toMatch(/SUM\s*\(|point_ledger|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
  expect((await authority.readProfileBalance(database([profile({resolved_code:null,cache_code:null})]),id)).available).toBe(false);
  expect((await authority.readProfileBalance(database([profile(),profile()]),id)).reason).toBe('source_unavailable');
});

function receiptDb(events,balances=[profile()]) {
  return {query:jest.fn(async sql=>({rows:sql.includes('FROM ada_points.native_events')?events:balances}))};
}
const receiptArgs={branchCode:'005',receiptNo:'S2610005001-000001',memberId:id};
test('receipt points read the original native award even when it no longer contributes to the balance',async()=>{
  const db=receiptDb([nativeEvent({active:false,contribution:'0',points_exact:'9'})]);
  const quote=await authority.readReceiptPoints(db,receiptArgs);
  expect(quote).toMatchObject({awardedPoints:9,awardedPointsExact:'9',balance:12.5,pointsStatus:'recorded_by_ada',pointsCredited:false});
  const [sql,params]=db.query.mock.calls[0];
  expect(params).toEqual(['005','S2610005001-000001']);
  expect(sql).toContain("e.card_type='1'");
  expect(sql).not.toMatch(/active\s*=|SUM\s*\(|point_ledger|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
});
test('an actual zero native award differs from no native award, neither credits again',async()=>{
  const zero=await authority.readReceiptPoints(receiptDb([nativeEvent({points_exact:'0'})]),receiptArgs);
  const absent=await authority.readReceiptPoints(receiptDb([]),receiptArgs);
  expect(zero).toMatchObject({awardedPoints:0,pointsStatus:'recorded_by_ada',pointsCredited:false});
  expect(absent).toMatchObject({awardedPoints:0,pointsStatus:'not_recorded_by_ada',pointsCredited:false});
});
test('multiple unique native events for the same approved owner are counted once each',async()=>{
  const quote=await authority.readReceiptPoints(receiptDb([nativeEvent(),nativeEvent({event_key:'b'.repeat(64),points_exact:'2'})]),receiptArgs);
  expect(quote.awardedPoints).toBe(5);
});
test.each([other,null,undefined])('receipt owner %s cannot be assigned to the selected member',async owner=>{
  await expect(authority.readReceiptPoints(receiptDb([nativeEvent({owner_member_id:owner})]),receiptArgs))
    .rejects.toMatchObject({status:409,code:'BILL_OWNER_CONFLICT'});
});
test.each(['review','retired',null])('native state %s fails closed instead of claiming no award',async state=>{
  await expect(authority.readReceiptPoints(receiptDb([nativeEvent({state})]),receiptArgs))
    .rejects.toMatchObject({status:409,code:'ADA_POINTS_EVENT_REVIEW'});
});
test.each([
  [nativeEvent(),nativeEvent()], [nativeEvent({event_key:'not-a-hash'})],
  [nativeEvent({points_exact:'1.5'})], [nativeEvent({points_exact:'-1'})], [nativeEvent({points_exact:'2147483648'})],
])('invalid or unrepresentable native awards cannot be silently rounded: %j',async events=>{
  await expect(authority.readReceiptPoints(receiptDb(events),receiptArgs)).rejects.toMatchObject({status:503});
});
test('a missing or stale native source is unavailable even for a bill without an award',async()=>{
  for(const balances of [[],[profile({observed_at:new Date(now.getTime()-120001)})],[profile({state:'review'})]]) {
    await expect(authority.readReceiptPoints(receiptDb([],balances),receiptArgs)).rejects.toMatchObject({status:503,code:'ADA_POINTS_SOURCE_UNAVAILABLE'});
  }
  const db={query:jest.fn(async()=>{throw Error('secret database value');})};
  await expect(authority.readReceiptPoints(db,receiptArgs)).rejects.toThrow('คะแนนจาก Ada ยังไม่พร้อม');
});
test('receipt identities are bounded and bound before touching the database',async()=>{
  const db=receiptDb([]);
  for(const args of [{...receiptArgs,branchCode:'005 OR 1=1'},{...receiptArgs,receiptNo:"S';DROP TABLE users--"},{...receiptArgs,memberId:'not-uuid'}]) {
    await expect(authority.readReceiptPoints(db,args)).rejects.toMatchObject({status:400});
  }
  expect(db.query).not.toHaveBeenCalled();
});
test('point history preserves exact values and never treats a business date as a new award timestamp',async()=>{
  const event={id:'a'.repeat(64),reference_id:'S-FIXTURE',original_points:'9007199254740993',contribution:'0',card_type:'1',state:'ready',active:false,
    native_date:'2026-11-02',native_insert_date:null,native_insert_time:null};
  const result=await authority.readPointHistory(receiptDb([event]),id);
  expect(result).toMatchObject({pointsAvailable:true,balance:12.5});
  expect(result.items[0]).toMatchObject({amount:null,amountExact:'9007199254740993',created_at:null,businessDate:'2026-11-02',contributionExact:'0'});
});
test('point history uses explicit Ada insertion time in Bangkok rather than cache observation time',async()=>{
  const event={id:'a'.repeat(64),original_points:'3',contribution:'-3',card_type:'2',state:'ready',active:true,native_date:'2026-11-01',
    native_insert_date:'2026-11-02T00:00:00.000Z',native_insert_time:'11:59:30'};
  const result=await authority.readPointHistory(receiptDb([event]),id);
  expect(result.items[0]).toMatchObject({amount:-3,amountExact:'-3',type:'redeem',created_at:'2026-11-02T04:59:30.000Z'});
});
test('point history never shows pending review data as a reliable history or falls back to old ledger',async()=>{
  const result=await authority.readPointHistory(receiptDb([{state:'review'}]),id);
  expect(result).toMatchObject({pointsAvailable:false,balance:null,items:[],pointsStatus:'source_unavailable'});
});
test('bounded receipt history uses two queries regardless of bill count and never conflates equal document numbers across branches',async()=>{
  const receipts=[{branchCode:'005',receiptNo:'S-FIXTURE'},{branchCode:'001',receiptNo:'S-FIXTURE'}];
  const db={query:jest.fn(async sql=>({rows:sql.includes('FROM requested r LEFT JOIN ada_points.native_events')?[
    {branch_code:'005',doc_no:'S-FIXTURE',...nativeEvent({points_exact:'9',active:false})},
    {branch_code:'001',doc_no:'S-FIXTURE',event_key:null},
  ]:[profile()]}))};
  const result=await authority.readReceiptPointSummaries(db,id,[...receipts,receipts[0]]);
  expect(db.query).toHaveBeenCalledTimes(2);expect(result.size).toBe(2);
  expect(result.get('005|S-FIXTURE')).toMatchObject({awardedPoints:9,pointsStatus:'recorded_by_ada',pointsCredited:false});
  expect(result.get('001|S-FIXTURE')).toMatchObject({awardedPoints:0,pointsStatus:'not_recorded_by_ada'});
  expect(db.query.mock.calls[1][1]).toEqual([['005','001'],['S-FIXTURE','S-FIXTURE']]);
});
test.each([
  [nativeEvent({owner_member_id:other}),'owner_conflict'],[nativeEvent({state:'retired'}),'event_review'],
  [nativeEvent({points_exact:'1.5'}),'source_unavailable'],[null,'source_unavailable'],
])('receipt history cannot show an unreliable award or substitute an archived value: %j',async(event,reason)=>{
  const db={query:jest.fn(async sql=>({rows:sql.includes('FROM requested r LEFT JOIN ada_points.native_events')?
    event?[{branch_code:'005',doc_no:'S-FIXTURE',...event}]:[]:[profile()]}))};
  const result=await authority.readReceiptPointSummaries(db,id,[{branchCode:'005',receiptNo:'S-FIXTURE'}]);
  expect(result.get('005|S-FIXTURE')).toMatchObject({awardedPoints:null,pointsAvailable:false,pointsStatus:reason});
});
test('receipt history has an explicit bound and never reads event rows from a stale source',async()=>{
  const db=database([profile({observed_at:new Date(now.getTime()-121000)})]);
  const receipt={branchCode:'005',receiptNo:'S-FIXTURE'};
  await expect(authority.readReceiptPointSummaries(db,id,Array(501).fill(receipt))).rejects.toMatchObject({status:400});
  expect(db.query).not.toHaveBeenCalled();
  const result=await authority.readReceiptPointSummaries(db,id,[receipt]);
  expect(result.get('005|S-FIXTURE')).toMatchObject({awardedPoints:null,pointsStatus:'stale'});
  expect(db.query).toHaveBeenCalledTimes(1);
});
