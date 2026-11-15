'use strict';
// Synthetic fixtures only. Run directly with node (no worker process).
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const model=require('../lib/memberPreorderModel');
const {createCatalog}=require('../lib/memberPreorderCatalog');
const {createMemberPreorders}=require('../lib/memberPreorders');
const member=randomUUID(),other=randomUUID(),actor={device_id:'synthetic-pos'};
const item={productCodes:['SKU-A'],productName:'Synthetic A 10 mg',quantity:2,unit:'กล่อง',sourceDescription:'ต้นฉบับอ่านไม่ชัด'};
const draft=()=>({requestId:randomUUID(),sourceReference:'synthetic-paper.jpg',items:[{...item}]});
const sale=(overrides={})=>({receiptNo:'S-SYNTHETIC-001',branchCode:'003',posCode:'001',soldAt:'2026-11-15T03:00:00Z',totalAmount:90,documentType:'1',items:[{productCode:'SKU-A',productName:item.productName,qty:3,lineTotal:90,unitCode:'BOX',unitName:'กล่อง'}],...overrides});
const history=[{id:randomUUID(),payload:{items:[item]}}];
const rejects=(fn,code)=>assert.rejects(fn,e=>e.code===code);

test('draft preserves unknown date, original units and source uncertainty',()=>{
 const d=model.draft(draft());assert.equal(d.occurredOn,null);assert.equal(d.frequencyMonths,null);
 assert.equal(d.items[0].sourceDescription,item.sourceDescription);assert.equal(d.items[0].unit,'กล่อง');
 for(const bad of [{items:[null]},{items:[]},{items:[{...item,quantity:-1}]},{...draft(),occurredOn:'2026-02-30'},{...draft(),frequencyMonths:0}])assert.throws(()=>model.draft(bad),e=>e.status===400);
});
test('exact product codes only: similar names/strengths never suggest a bill',()=>{
 assert.equal(model.candidates(member,history,[sale({items:[{...sale().items[0],productCode:'SKU-B'}]})]).length,0);
 assert.equal(model.candidates(member,history,[sale()]).length,1);
 assert.equal(model.candidates(member,history,[sale({documentType:'9'})]).length,0);
});
test('void pairs cancel; final receipt amount and actual unit survive',()=>{
 const zero={...sale().items[0],qty:-3,lineTotal:-90};
 assert.equal(model.candidates(member,history,[sale({items:[sale().items[0],zero]})]).length,0);
 const c=model.candidates(member,history,[sale()])[0];assert.equal(c.totalAmount,90);assert.equal(c.items[0].unitName,'กล่อง');
});
test('duplicate receipt copies appear once; differing copies are held',()=>{
 assert.equal(model.candidates(member,history,[sale(),sale()]).length,1);
 assert.equal(model.candidates(member,history,[sale(),sale({totalAmount:91})])[0].needsReview,true);
});
test('fingerprint retains member, final totals, units and returns',()=>{
 const a=model.candidates(member,history,[sale()])[0];
 for(const changed of [sale({totalAmount:91}),sale({returns:[{refundDocNo:'R-SYNTHETIC',refundTotal:10}]}),sale({items:[{...sale().items[0],unitName:'แผง'}]})])assert.notEqual(a.fingerprint,model.candidates(member,history,[changed])[0].fingerprint);
 assert.notEqual(a.fingerprint,model.candidates(other,history,[sale()])[0].fingerprint);
});
test('catalog uses verified name; ambiguous codes must name identical products',async()=>{
 const rows=[{productCode:'SKU-A',productName:'Synthetic 10 mg',unit:'กล่อง'},{productCode:'SKU-A2',productName:'Synthetic 10 mg',unit:'กล่อง'},{productCode:'SKU-B',productName:'Synthetic 20 mg',unit:'กล่อง'}];
 const catalog=createCatalog({fetcher:async()=>({ok:true,text:async()=>JSON.stringify(rows)})});
 const verified=await catalog.validate([{...item,productName:'wrong name'}]);assert.equal(verified[0].productName,rows[0].productName);
 assert.equal((await catalog.validate([{...item,productCodes:['SKU-A','SKU-A2']}]))[0].matchStatus,'ambiguous');
 await rejects(()=>catalog.validate([{...item,productCodes:['SKU-A','SKU-B']}]),'DIFFERENT_CATALOG_PRODUCTS');
 assert.equal((await catalog.validate([{...item,productCodes:[]}]))[0].matchStatus,'unresolved');
});
test('catalog network failures are explicit; no made-up products',async()=>{
 await rejects(()=>createCatalog({fetcher:async()=>{throw Error('synthetic offline')}}).search('SKU-A'),'CATALOG_UNAVAILABLE');
});

const database=process.env.SCCRM_PREORDER_TEST_DATABASE_URL;
test('PostgreSQL copy: routes, idempotence, confirmation and preservation',{skip:!database},async t=>{
 const url=new URL(database);
 assert.ok(['127.0.0.1','localhost'].includes(url.hostname)&&/^\/crm_preorders_test_[a-f0-9]+$/.test(url.pathname),'Dedicated empty local copy only');
 const {Pool}=require('pg'),db=new Pool({connectionString:database,ssl:false,max:3});
 let catalogOffline=false;const catalog={search:async()=>[],validate:async items=>{if(catalogOffline)throw Error('synthetic catalog offline');return items}};
 let purchases=[sale()],offline=false;
 const receiptHistory=async(id,q)=>{if(offline)throw Error('synthetic unavailable');return {purchases:id===member?purchases:[],hasMore:false,nextCursor:null}};
 const service=createMemberPreorders({db,catalog,history:receiptHistory,ada:{legacyProfile:async()=>null}});
 const express=require('express'),request=require('supertest');
 const {hashOpaqueToken}=require('../lib/sccrm');
 const token='synthetic-preorder-staff';process.env.SCCRM_REFRESH_TOKEN_SECRET='synthetic-preorder-test-only';
 let app;
 const send=(method,route,body,auth=token)=>{let req=request(app)[method]('/api/members/'+route);if(auth)req=req.set('Authorization','Bearer '+auth);return body?req.send(body):req};
 try{
  assert.equal((await db.query("SELECT to_regclass('public.users') IS NULL empty")).rows[0].empty,true);
  await db.query(`CREATE TABLE public.users(id uuid PRIMARY KEY,full_name text,remark text);
   CREATE TABLE public.member_profiles(user_id uuid PRIMARY KEY REFERENCES users(id),member_code text,is_active boolean);
   CREATE TABLE public.staff_devices(id uuid PRIMARY KEY,device_id text,device_name text,branch_id uuid,token_hash text,revoked_at timestamptz);
   CREATE TABLE public.loyalty_claims(id uuid PRIMARY KEY,member_id uuid,total numeric);
   CREATE TABLE public.point_ledger(id uuid PRIMARY KEY,member_id uuid,points numeric);`);
  for(const id of [member,other]){await db.query('INSERT INTO users VALUES($1,$2,$3)',[id,'Synthetic '+id,'Existing personal notes']);await db.query('INSERT INTO member_profiles VALUES($1,$2,true)',[id,'AR003-SYNTHETIC-'+id]);}
  await db.query('INSERT INTO loyalty_claims VALUES($1,$2,90)',[randomUUID(),member]);await db.query('INSERT INTO point_ledger VALUES($1,$2,7)',[randomUUID(),member]);
  await db.query('INSERT INTO staff_devices(id,device_id,token_hash)VALUES($1,$2,$3)',[randomUUID(),actor.device_id,hashOpaqueToken(token)]);
  const original=await db.query('SELECT (SELECT jsonb_agg(u) FROM users u) users,(SELECT jsonb_agg(c) FROM loyalty_claims c) claims,(SELECT jsonb_agg(p) FROM point_ledger p) points');
  const sql=fs.readFileSync(path.join(__dirname,'../schema/memberPreorders.sql'),'utf8');await db.query(sql);await db.query(sql);
  await rejects(()=>service.list(member),'PREORDER_UNAVAILABLE');await db.query('UPDATE sccrm_preorders.meta SET enabled=true');
  app=express();app.use(express.json());app.use('/api/members',require('../routes/memberPreorders').createMemberPreorderRouter({db,service}));
  await t.test('all endpoints require staff bearer, never a customer or revoked token',async()=>{
   for(const [method,route,body] of [['get',member+'/preorders'],['get','preorders/catalog?q=SKU'],['post',member+'/preorders',draft()],['post',member+'/preorders/receipt-confirmations',{}],['post',member+'/preorders/receipt-confirmations/'+randomUUID()+'/revoke',{}]])assert.equal((await send(method,route,body,null)).status,401);
   assert.equal((await send('get',member+'/preorders',null,'synthetic-customer-token')).status,401);
   await db.query('UPDATE staff_devices SET revoked_at=now()');assert.equal((await send('get',member+'/preorders')).status,401);await db.query('UPDATE staff_devices SET revoked_at=NULL');
  });
  let saved;
  await t.test('retries and response loss create one row and one version',async()=>{
   const body=draft();saved=await service.save(member,body,actor);const again=await service.save(member,body,actor);assert.deepEqual(again,JSON.parse(JSON.stringify(saved)));
   catalogOffline=true;assert.deepEqual(await service.save(member,body,actor),again);catalogOffline=false;
   assert.equal((await db.query('SELECT count(*)::int n FROM sccrm_preorders.histories')).rows[0].n,1);
   await rejects(()=>service.save(member,{...body,notes:'changed after response loss'},actor),'REQUEST_CHANGED');
  });
  await t.test('optimistic versions preserve older paper/staff data',async()=>{
   const body={...draft(),id:saved.record.id,version:1,notes:'Staff correction'};
   const results=await Promise.allSettled([service.save(member,body,actor),service.save(member,{...body,requestId:randomUUID()},actor)]);
   assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'VERSION_CONFLICT');
   assert.equal((await db.query('SELECT count(*)::int n FROM sccrm_preorders.history_versions')).rows[0].n,2);
   await rejects(()=>service.save(other,{...body,requestId:randomUUID()},actor),'HISTORY_NOT_FOUND');
  });
  await t.test('manual data works when receipt service is down',async()=>{
   offline=true;const r=await send('get',member+'/preorders');assert.equal(r.status,200);assert.equal(r.body.receiptsAvailable,false);assert.equal(r.body.records.length,1);
   assert.equal((await service.save(member,{...draft(),items:[{...item,productCodes:[]}]},actor)).ok,true);offline=false;
  });
  await t.test('paper import is idempotent after staff edits and keeps source label',async()=>{
   const source={kind:'paper_import',reference:'sha256:'+model.hash('synthetic-document'),row:18};
   const imported=await service.save(member,draft(),actor,source);assert.equal(imported.record.sourceReference,'synthetic-paper.jpg');
   await service.save(member,{...draft(),id:imported.record.id,version:1,sourceReference:'changed label',notes:'Keep corrected source'},actor);
   const again=await service.save(member,draft(),actor,source);assert.equal(again.record.version,2);assert.equal(again.record.notes,'Keep corrected source');assert.equal(again.record.sourceReference,'synthetic-paper.jpg');
  });
  await t.test('operator plan requires existing UUID/AR/source and resumes without duplicates',async()=>{
   const {importPlan}=require('../scripts/import-member-preorders.cjs');
   const plan={source:{reference:'sha256:'+model.hash('synthetic-operator-paper'),label:'synthetic-paper.jpg'},entries:[{memberId:other,memberCode:'AR003-SYNTHETIC-'+other,sourceRow:26,expectedSourceMarker:'Existing personal notes',history:draft()}]};
   const preflight=await importPlan(plan,{db,catalog});assert.equal(preflight.mode,'plan');
   assert.equal((await db.query('SELECT count(*)::int n FROM sccrm_preorders.histories WHERE member_id=$1',[other])).rows[0].n,0);
   assert.equal((await importPlan(plan,{db,catalog,apply:true})).created,1);assert.equal((await importPlan(plan,{db,catalog,apply:true})).replayed,1);
   await assert.rejects(()=>importPlan({...plan,entries:[{...plan.entries[0],memberCode:'AR-WRONG'}]},{db,catalog,apply:true}),/proof mismatch/);
  });
  let candidate,link;
  await t.test('matches remain proposals until explicit staff confirmation',async()=>{
   const result=await send('get',member+'/preorders');assert.equal(result.body.confirmedBills.length,0);assert.equal(result.body.candidates.length,1);candidate=result.body.candidates[0];
   assert.match(result.headers['cache-control'],/no-store/);
   assert.equal((await db.query('SELECT count(*)::int n FROM sccrm_preorders.bill_links')).rows[0].n,0);
  });
  await t.test('stale receipts and other members cannot be confirmed',async()=>{
   const body={requestId:randomUUID(),...candidate};purchases=[sale({totalAmount:91})];await rejects(()=>service.confirm(member,body,actor),'RECEIPT_CHANGED');purchases=[sale()];
   await rejects(()=>service.confirm(other,{...body,requestId:randomUUID()},actor),'RECEIPT_CHANGED');
   purchases=[sale(),sale({totalAmount:91})];await rejects(()=>service.confirm(member,{...body,requestId:randomUUID()},actor),'RECEIPT_CHANGED');purchases=[sale()];
  });
  await t.test('confirm retries and repeated clicks never duplicate a bill',async()=>{
   const body={requestId:randomUUID(),...candidate};const r=await send('post',member+'/preorders/receipt-confirmations',body);assert.equal(r.status,200);link=r.body.bill;
   assert.deepEqual((await send('post',member+'/preorders/receipt-confirmations',body)).body,r.body);
   assert.equal((await service.confirm(member,{...body,requestId:randomUUID()},actor)).replayed,true);
   const list=await service.list(member);assert.equal(list.candidates.length,0);assert.equal(list.confirmedBills.length,1);
   assert.equal((await db.query('SELECT count(*)::int n FROM sccrm_preorders.bill_links')).rows[0].n,1);
  });
  await t.test('changed receipt is flagged; revocation is audited and scoped',async()=>{
   purchases=[sale({totalAmount:91})];assert.equal((await service.list(member)).confirmedBills[0].needsReview,true);
   await rejects(()=>service.revoke(other,link.id,{requestId:randomUUID(),reason:'synthetic wrong person'},actor),'BILL_LINK_NOT_FOUND');
   await service.revoke(member,link.id,{requestId:randomUUID(),reason:'Staff correction'},actor);
   assert.equal((await db.query('SELECT count(*)::int n FROM sccrm_preorders.bill_links WHERE revoked_at IS NOT NULL')).rows[0].n,1);
   assert.ok((await db.query('SELECT count(*)::int n FROM sccrm_preorders.events')).rows[0].n>=5);
  });
  await t.test('feature pause and inactive members prevent writes without touching history',async()=>{
   await db.query('UPDATE member_profiles SET is_active=false WHERE user_id=$1',[other]);await rejects(()=>service.save(other,draft(),actor),'MEMBER_INACTIVE');
   await db.query('UPDATE sccrm_preorders.meta SET enabled=false');assert.equal((await send('get',member+'/preorders')).status,503);
   const after=await db.query('SELECT (SELECT jsonb_agg(u) FROM users u) users,(SELECT jsonb_agg(c) FROM loyalty_claims c) claims,(SELECT jsonb_agg(p) FROM point_ledger p) points');assert.deepEqual(after.rows,original.rows);
   const rls=(await db.query("SELECT bool_and(relrowsecurity) ok FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='sccrm_preorders' AND c.relkind='r'")).rows[0];assert.equal(rls.ok,true);
  });
 }finally{await db.end()}
});
