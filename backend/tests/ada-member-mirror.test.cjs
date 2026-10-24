const ada = require('../lib/adaMemberMirror');

const id = '11111111-1111-4111-8111-111111111111';
const contact = {directory_id:id,source_id:'hq000/AdaAcc',ada_code:'AR001-000001',name:'Test contact',active:'1'};
afterEach(() => { delete process.env.SC_OFFICIAL_ADA_SYNC_ENABLED; });

test('disabled feature never reads or materializes a legacy identity', async () => {
  const db={query:jest.fn()};
  expect(await ada.legacyProfile(db,id)).toBeNull();
  expect(await ada.searchLegacy(db,'0812345678')).toEqual([]);
  await ada.ensureLegacyMember(db,id);
  expect(db.query).not.toHaveBeenCalled();
});

test('only literal true enables the feature', () => {
  process.env.SC_OFFICIAL_ADA_SYNC_ENABLED='false';
  expect(ada.enabled()).toBe(false);
  process.env.SC_OFFICIAL_ADA_SYNC_ENABLED='true';
  expect(ada.enabled()).toBe(true);
});

test('explicit staff selection does not turn an unverified Ada email into a login', async () => {
  process.env.SC_OFFICIAL_ADA_SYNC_ENABLED='true';
  const db={query:jest.fn(async sql=>({rows:sql.includes('SELECT * FROM ada_history.customers')?[contact]:[]}))};
  await ada.ensureLegacyMember(db,id);
  const calls=db.query.mock.calls;
  expect(calls[0][0]).toContain('pg_advisory_xact_lock');
  expect(calls.find(([sql])=>sql.startsWith('INSERT INTO public.users'))).toEqual([
    expect.stringContaining('VALUES($1,$2,NULL,NULL,false)'),[id,'Test contact'],
  ]);
  expect(calls.find(([sql])=>sql.startsWith('INSERT INTO public.member_profiles'))[1]).toEqual([id,'ADA-AR001-000001']);
  expect(calls.find(([sql])=>sql.startsWith('INSERT INTO ada_history.member_links'))[1]).toEqual([
    id,'hq000/AdaAcc','AR001-000001','authenticated staff selection',
  ]);
  expect(calls.some(([sql])=>/point_ledger|password_hash/.test(sql))).toBe(false);
});

test('an existing online member is not inserted again', async () => {
  process.env.SC_OFFICIAL_ADA_SYNC_ENABLED='true';
  const db={query:jest.fn(async sql=>({rows:sql.startsWith('SELECT id FROM public.users')?[{id}]:[]}))};
  await ada.ensureLegacyMember(db,id);
  expect(db.query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
});

test('an Ada identity already bound to another member cannot be reassigned', async () => {
  process.env.SC_OFFICIAL_ADA_SYNC_ENABLED='true';
  const db={query:jest.fn(async sql=>({rows:sql.includes('SELECT * FROM ada_history.customers')?[contact]:sql.startsWith('SELECT member_id')?[{member_id:'22222222-2222-4222-8222-222222222222'}]:[]}))};
  await expect(ada.ensureLegacyMember(db,id)).rejects.toMatchObject({status:409});
  expect(db.query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
});

test('legacy search works when points storage is unavailable and keeps separate codes', async () => {
  process.env.SC_OFFICIAL_ADA_SYNC_ENABLED='true';
  const db={query:jest.fn(async()=>({rows:[{id,display_name:'Contact A',phone:'0812345678',member_code:'ADA-AR001-000001',current_points:0},{id:'other-code',display_name:'Contact A',phone:'0812345678',member_code:'ADA-AR001-000002',current_points:0}]}))};
  const found=await ada.searchLegacy(db,'0812345678',{pointsAvailable:false});
  expect(found).toHaveLength(2);
  expect(found[0].id).not.toBe(found[1].id);
  expect(db.query.mock.calls[0][0]).not.toContain('point_ledger');
  expect(db.query.mock.calls[0][0]).toContain("d.member_code<>'ADA-0'");
});
