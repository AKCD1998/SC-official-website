const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Pool}=require('pg'),express=require('express'),request=require('supertest');
const {createFleetRouter}=require('../routes/sccrmFleet');
const {hashOpaqueToken}=require('../lib/sccrm');
const database=process.env.SC_OFFICIAL_FLEET_TEST_DATABASE_URL;
const suite=database?describe:describe.skip;
suite('fleet queue on a fresh, explicitly isolated PostgreSQL database',()=>{
 let pool,app,release;
 const node='nFQPDepQTh11CNTRL',otherNode='nSKeeNSVgt11CNTRL';
 const one='11111111-1111-4111-8111-111111111111',two='22222222-2222-4222-8222-222222222222';
 const adminId='33333333-3333-4333-8333-333333333333';
 const admin='fleet-admin-fixture-secret-00000001',staff='fleet-staff-fixture-secret-00000001',other='fleet-staff-fixture-secret-00000002';
 const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
 const previousStaffSecret=process.env.SCCRM_REFRESH_TOKEN_SECRET;
 const pollBody=(n=node)=>({protocol:1,nodeId:n,hostname:n===node?'POS2':'POSSRV',version:'1.3.15.0',binaryHash:'b'.repeat(64),readiness:'idle'});
 const send=(endpoint,body,token=staff)=>request(app).post(endpoint).set('Authorization','Bearer '+token).send(body);
 const poll=()=>send('/device/poll',pollBody());
 const issue=(id=crypto.randomUUID())=>send('/admin/commands',{requestId:id,nodeIds:[node],expectedReleaseHash:release.sha256},admin);
 const report=(id,state,extra={},token=staff)=>send('/device/report',{jobId:id,state,code:'TEST',...extra},token);
 const enable=()=>pool.query('UPDATE sccrm_fleet.settings SET enabled=true WHERE id=1');
 beforeAll(async()=>{
  process.env.SCCRM_REFRESH_TOKEN_SECRET='isolated-fleet-staff-hmac-fixture';
  const url=new URL(database);
  if(!['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname)||!/^\/crm_fleet_test_[a-z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_FLEET_DATABASE_REQUIRED');
  pool=new Pool({connectionString:database,max:4});
  if((await pool.query("SELECT to_regnamespace('sccrm_fleet') AS existing")).rows[0].existing)throw Error('FRESH_FLEET_DATABASE_REQUIRED');
  await pool.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon')THEN CREATE ROLE anon NOLOGIN;END IF;
   IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated')THEN CREATE ROLE authenticated NOLOGIN;END IF;END $$;
   CREATE TABLE public.staff_devices(id uuid PRIMARY KEY,device_id text,token_hash text,revoked_at timestamptz);
   CREATE TABLE public.customer_sentinel(id integer PRIMARY KEY,payload text);INSERT INTO public.customer_sentinel VALUES(1,'existing-customer-code-owner-score-unchanged');`);
  await pool.query(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261103060203_sccrm_fleet_manual_updates.sql'),'utf8'));
  await pool.query('INSERT INTO public.staff_devices(id,device_id,token_hash) VALUES($1,$2,$3),($4,$5,$6)',[one,'fixture-one',hashOpaqueToken(staff),two,'fixture-two',hashOpaqueToken(other)]);
  await pool.query("INSERT INTO sccrm_fleet.admin_keys(id,token_hash,station) VALUES($1,$2,'SCPRODUCTDEV')",[adminId,hash(admin)]);
 });
 beforeEach(async()=>{
  await pool.query('TRUNCATE sccrm_fleet.events,sccrm_fleet.jobs,sccrm_fleet.batches,sccrm_fleet.devices RESTART IDENTITY CASCADE');
  await pool.query('UPDATE sccrm_fleet.settings SET enabled=false WHERE id=1;UPDATE public.staff_devices SET revoked_at=NULL');
  await pool.query('UPDATE public.staff_devices SET token_hash=$2 WHERE id=$1',[one,hashOpaqueToken(staff)]);
  release={version:'1.3.16',sha256:'a'.repeat(64),envelope:'isolated signed-release fixture'};
  app=express();app.use(createFleetRouter({pool,getRelease:async()=>release}));
 });
 afterAll(async()=>{try{if(pool){expect((await pool.query('SELECT payload FROM public.customer_sentinel WHERE id=1')).rows[0].payload).toBe('existing-customer-code-owner-score-unchanged');await pool.end();}}finally{if(previousStaffSecret===undefined)delete process.env.SCCRM_REFRESH_TOKEN_SECRET;else process.env.SCCRM_REFRESH_TOKEN_SECRET=previousStaffSecret;}});
 test('existing staff login HMAC authenticates without changing its stored token',async()=>{
  const before=(await pool.query('SELECT token_hash FROM public.staff_devices WHERE id=$1',[one])).rows[0].token_hash;
  expect(before).toBe(hashOpaqueToken(staff));expect(before).not.toBe(hash(staff));
  expect((await poll()).status).toBe(200);
  expect((await pool.query('SELECT token_hash FROM public.staff_devices WHERE id=$1',[one])).rows[0].token_hash).toBe(before);
 });
 test('an unnamespaced SHA token digest cannot authenticate as an existing staff session',async()=>{
  await pool.query('UPDATE public.staff_devices SET token_hash=$2 WHERE id=$1',[one,hash(staff)]);
  expect((await poll()).status).toBe(401);
  expect((await pool.query('SELECT count(*)::int AS n FROM sccrm_fleet.devices')).rows[0].n).toBe(0);
 });
 test('default disabled inventory shows every approved POS without inventing enrollment',async()=>{
  const r=await request(app).get('/admin/status').set('Authorization','Bearer '+admin);
  expect(r.status).toBe(200);expect(r.body.enabled).toBe(false);expect(r.body.devices).toHaveLength(8);
  expect(r.body.devices.every(d=>!d.enrolled&&d.online===false)).toBe(true);expect(JSON.stringify(r.body)).not.toMatch(/token_hash|secret-000|customer_sentinel/);
 });
 test('ordinary polling never creates an update command',async()=>{
  await enable();for(let i=0;i<3;i++){const r=await poll();expect(r.status).toBe(200);expect(r.body.command).toBeNull();}
  expect((await pool.query('SELECT count(*)::int AS n FROM sccrm_fleet.jobs')).rows[0].n).toBe(0);
 });
 test('offline device retains a command and receives it on its next poll',async()=>{
  await poll();await enable();await pool.query("UPDATE sccrm_fleet.devices SET last_seen_at=now()-interval '1 day'");
  const created=await issue();expect(created.body.jobs).toHaveLength(1);
  const delivered=await poll();expect(delivered.body.command.id).toBe(created.body.jobs[0].id);expect(delivered.body.command.nodeId).toBe(node);
 });
 test('restart of the database client does not lose a command',async()=>{
  await poll();await enable();const created=await issue();const fresh=new Pool({connectionString:database});
  try{const result=await require('../lib/sccrmFleetStore').heartbeat(fresh,{id:one},pollBody());expect(result.command.id).toBe(created.body.jobs[0].id);}finally{await fresh.end();}
 });
 test('manual retry after a lost response returns the same persisted batch',async()=>{
  await poll();await enable();const id=crypto.randomUUID(),first=await issue(id),retry=await issue(id);
  expect(retry.body).toEqual({...first.body,replayed:true});
  expect((await pool.query('SELECT count(*)::int AS n FROM sccrm_fleet.jobs')).rows[0].n).toBe(1);
 });
 test('a second click cannot overlap an active command',async()=>{
  await poll();await enable();const first=await issue(),second=await issue();
  expect(second.body.jobs).toHaveLength(0);expect(second.body.notReady[0]).toMatchObject({code:'COMMAND_IN_PROGRESS',jobId:first.body.jobs[0].id});
 });
 test('same request ID cannot be reused for a different release',async()=>{
  await poll();await enable();const id=crypto.randomUUID();await issue(id);release={...release,sha256:'c'.repeat(64)};
  expect((await issue(id)).status).toBe(409);
 });
 test('missing bootstrap is explicit and does not block an enrolled sibling',async()=>{
  await poll();await enable();const r=await send('/admin/commands',{requestId:crypto.randomUUID(),nodeIds:[node,otherNode],expectedReleaseHash:release.sha256},admin);
  expect(r.body.jobs).toHaveLength(1);expect(r.body.notReady).toEqual([{nodeId:otherNode,code:'NEEDS_BOOTSTRAP'}]);
 });
 test('wrong staff token cannot receive or report another POS command',async()=>{
  await poll();await enable();const created=await issue();
  expect((await send('/device/poll',pollBody(otherNode),other)).body.command).toBeNull();
  expect((await report(created.body.jobs[0].id,'succeeded',{installedHash:release.sha256},other)).status).toBe(404);
 });
 test('node takeover or moving a registered device requires review',async()=>{
  await poll();expect((await send('/device/poll',pollBody(),other)).status).toBe(409);
  expect((await send('/device/poll',pollBody(otherNode))).status).toBe(409);
  expect((await pool.query('SELECT node_id FROM sccrm_fleet.devices WHERE staff_device_id=$1',[one])).rows[0].node_id).toBe(node);
 });
 test('revoked device cannot poll or acknowledge',async()=>{
  await poll();await enable();const created=await issue();await pool.query('UPDATE public.staff_devices SET revoked_at=now() WHERE id=$1',[one]);
  expect((await poll()).status).toBe(401);expect((await report(created.body.jobs[0].id,'downloading')).status).toBe(401);
 });
 test('save-in-progress can remain waiting without becoming complete',async()=>{
  await poll();await enable();const id=(await issue()).body.jobs[0].id;
  for(let i=0;i<3;i++)expect((await report(id,'waiting_for_idle')).status).toBe(200);
  const row=(await pool.query('SELECT state,completed_at FROM sccrm_fleet.jobs WHERE id=$1',[id])).rows[0];expect(row).toMatchObject({state:'waiting_for_idle',completed_at:null});
 });
 test('work that starts during the final check can defer installation again',async()=>{
  await poll();await enable();const id=(await issue()).body.jobs[0].id;
  expect((await report(id,'installing')).status).toBe(200);expect((await report(id,'waiting_for_idle')).status).toBe(200);
 });
 test('pause prevents starting installation but preserves queued commands',async()=>{
  await poll();await enable();const id=(await issue()).body.jobs[0].id;
  await report(id,'downloading');await send('/admin/pause',{enabled:false},admin);
  expect((await report(id,'installing')).status).toBe(409);expect((await poll()).body.command).toBeNull();
  await send('/admin/pause',{enabled:true},admin);expect((await poll()).body.command.id).toBe(id);
 });
 test('success requires the exact target hash and lost acknowledgement is idempotent',async()=>{
  await poll();await enable();const id=(await issue()).body.jobs[0].id;
  expect((await report(id,'succeeded',{installedHash:'c'.repeat(64)})).status).toBe(409);
  expect((await report(id,'succeeded',{installedHash:release.sha256})).status).toBe(200);
  expect((await report(id,'succeeded',{installedHash:release.sha256})).body.replayed).toBe(true);
  expect((await poll()).body.command).toBeNull();
 });
 test('one failed device does not block another target',async()=>{
  await poll();await send('/device/poll',pollBody(otherNode),other);await enable();
  const r=await send('/admin/commands',{requestId:crypto.randomUUID(),nodeIds:[node,otherNode],expectedReleaseHash:release.sha256},admin);
  const own=r.body.jobs.find(j=>j.nodeId===node);await report(own.id,'failed');
  expect((await send('/device/poll',pollBody(otherNode),other)).body.command.nodeId).toBe(otherNode);
 });
 test.each([['protocol',{protocol:2}],['arbitrary command',{command:'taskkill /im AdaPosFront.exe'}],['unapproved node',{nodeId:'unapproved'}]])('rejects %s before enrollment',async(_,changed)=>{
  const r=await send('/device/poll',{...pollBody(),...changed});expect([400,403]).toContain(r.status);
  expect((await pool.query('SELECT count(*)::int AS n FROM sccrm_fleet.devices')).rows[0].n).toBe(0);
 });
 test('anonymous and staff callers cannot access the admin console',async()=>{
  expect((await request(app).get('/admin/status')).status).toBe(401);
  expect((await request(app).get('/admin/status').set('Authorization','Bearer '+staff)).status).toBe(403);
  expect((await send('/admin/pause',{enabled:true})).status).toBe(403);
 });
 test('private operational data is not exposed to browser database roles',async()=>{
  const r=(await pool.query("SELECT has_schema_privilege('anon','sccrm_fleet','usage') AS anon,has_schema_privilege('authenticated','sccrm_fleet','usage') AS authenticated")).rows[0];
  expect(r).toEqual({anon:false,authenticated:false});
 });
});
