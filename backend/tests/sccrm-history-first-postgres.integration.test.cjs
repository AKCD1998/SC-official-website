'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const express=require('express'),request=require('supertest'),{Pool}=require('pg');
let mockPool;
jest.mock('../db',()=>({query:(...args)=>mockPool.query(...args),connect:()=>mockPool.connect()}));
jest.mock('@sendgrid/mail',()=>({setApiKey:jest.fn(),send:jest.fn()}));
const outbox=require('../lib/sccrmHistoryFirst');
const {hashOpaqueToken}=require('../lib/sccrm');
const {provisionMemberRegistrationReporting}=require('../scripts/provision-member-registration-reporting.cjs');
const run=process.env.SCCRM_HISTORY_FIRST_TEST_DATABASE_URL;
const describeDb=run?describe:describe.skip;
const migration='../supabase/migrations/20261111073157_sccrm_history_first_outbox.sql';
const read=file=>fs.readFileSync(path.join(__dirname,file),'utf8');
const token='synthetic-history-first-device',otherToken='synthetic-history-first-other-branch';
const source='hq000/AdaAcc';
let app,sequence=0,baseSnapshot;
const oldEnv={...process.env};
async function member(name='Synthetic Pending'){
 const id=crypto.randomUUID();
 await mockPool.query('INSERT INTO users(id,full_name,phone_number) VALUES($1,$2,$3)',[id,name,'099'+String(++sequence).padStart(7,'0')]);
 await mockPool.query('INSERT INTO member_profiles(user_id,member_code) VALUES($1,$2)',[id,'SCM-'+id.replaceAll('-','').slice(0,8).toUpperCase()]);
 return id;
}
function body(id,doc='S-FIXTURE-'+crypto.randomUUID()){
 return {memberId:id,receiptNo:doc.toUpperCase(),branchCode:'005',posCode:'002',soldAt:'2026-11-11T09:10:11+07:00',
  totalAmount:100,receiptTotalAmount:100,receiptDiscount:0,items:[{seq:1,productCode:'SKU-FIXTURE',productName:'Synthetic medicine',barcode:'8850000000001',unitCode:'BOX',unitName:'กล่อง',qty:2,unitPrice:50,lineTotal:100}]};
}
const send=value=>request(app).post('/api/loyalty/claims').set('Authorization','Bearer '+token).send(value);
const auth=(method,url,staff=token)=>request(app)[method](url).set('Authorization','Bearer '+staff);
async function jobFor(claimId){return (await mockPool.query('SELECT * FROM sccrm_receipt_sync.jobs WHERE claim_id=$1',[claimId])).rows[0];}
async function link(id,code){
 await mockPool.query(`INSERT INTO ada_history.customers(source_id,ada_code,name,phone,active,source_payload,payload_hash,source_snapshot)
  VALUES($1,$2,'Synthetic linked','0990000000','1',$3,$4,$5) ON CONFLICT DO NOTHING`,[source,code,{FTCstCode:code},'a'.repeat(64),crypto.randomUUID()]);
 await mockPool.query('INSERT INTO ada_history.member_links VALUES($1,$2,$3,$4)',[id,source,code,'synthetic copy approval']);
 await mockPool.query('UPDATE member_profiles SET member_code=$2 WHERE user_id=$1',[id,code]);
}
describeDb('SCCRM-first history with durable real PostgreSQL copies',()=>{
 beforeAll(async()=>{
  process.env.SCCRM_REFRESH_TOKEN_SECRET='synthetic-history-first-secret';
  const url=new URL(run);
  if(!['127.0.0.1','localhost'].includes(url.hostname)||(url.port==='5432'&&process.env.CI!=='true')||!/^\/crm_history_first_test_/.test(url.pathname))throw Error('Dedicated local history test database required');
  mockPool=new Pool({connectionString:run,ssl:false});
  if(!(await mockPool.query("SELECT to_regclass('public.users') IS NULL empty")).rows[0].empty)throw Error('Empty disposable database required');
  await mockPool.query(read('../migrations/202610200001_crm_counter_bootstrap.sql'));
  await mockPool.query(read('../migrations/202610210001_central_promotions.sql'));
  await mockPool.query(read('../migrations/202610210002_purchase_history.sql'));
  await mockPool.query(read('../sql/ada-member-mirror.sql'));
  await mockPool.query(`CREATE SCHEMA ada_points;
   CREATE TABLE ada_points.balance_cache(ada_code text PRIMARY KEY,balance numeric,observed_at timestamptz,state text);
   CREATE TABLE ada_points.native_events(event_key char(64) PRIMARY KEY,origin_branch text,doc_no text,ada_code text,card_type text,points bigint,state text,active boolean);
   CREATE SCHEMA sccrm_member_codes;
   CREATE TABLE sccrm_member_codes.assignments(assignment_id uuid PRIMARY KEY,member_id uuid UNIQUE,ada_code text,deliver_to_branches boolean,assigned_at timestamptz DEFAULT now());
   CREATE TABLE sccrm_member_codes.targets(target_id text PRIMARY KEY,branch_code text,enabled boolean);
   CREATE TABLE sccrm_member_codes.jobs(target_id text,assignment_id uuid,state text,last_code text,id uuid DEFAULT gen_random_uuid(),completed_at timestamptz,member_id uuid);
   CREATE TABLE sccrm_member_codes.events(job_id uuid,occurred_at timestamptz,state text);
   CREATE TABLE sccrm_member_codes.mappings(target_id text,assignment_id uuid,member_id uuid,ada_code text);
   INSERT INTO sccrm_member_codes.targets SELECT v,v,true FROM unnest(ARRAY['001','003','004','005']) v;`);
  const client=await mockPool.connect();try{await provisionMemberRegistrationReporting(client,{apply:true,activate:true});}finally{client.release();}
  await mockPool.query(read(migration));await mockPool.query(read(migration));
  await mockPool.query(read('../supabase/migrations/20261111073159_sccrm_native_receipt_delivery.sql'));
  await mockPool.query(read('../supabase/migrations/20261112021505_sccrm_receipt_final_revisions.sql'));
  await mockPool.query(read('../supabase/migrations/20261112044140_sccrm_receipt_completeness.sql'));
  await mockPool.query('UPDATE sccrm_receipt_sync.meta SET enabled=true');
  for(const [code,staffToken] of [['005',token],['003',otherToken]]){
   const branch=crypto.randomUUID();await mockPool.query('INSERT INTO branches(id,name,code) VALUES($1,$2,$3)',[branch,'Synthetic '+code,code]);
   await mockPool.query('INSERT INTO staff_devices(device_id,device_name,token_hash,branch_id) VALUES($1,$2,$3,$4)',[staffToken,'Synthetic device',hashOpaqueToken(staffToken),branch]);
  }
  Object.assign(process.env,{SC_OFFICIAL_ADA_POINTS_MODE:'ada-primary',SC_OFFICIAL_SCCRM_HISTORY_FIRST_ENABLED:'true',SC_OFFICIAL_ADA_SYNC_ENABLED:'false',SC_OFFICIAL_RECEIPT_WORKER_TOKEN:'synthetic-receipt-worker-private-secret'});
  app=express();app.use(express.json());app.use('/api/loyalty',require('../routes/loyalty'));app.use('/api/members',require('../routes/loyalty'));app.use('/internal',require('../routes/sccrmInternal'));
  const original=await member('Original untouched customer');await link(original,'AR005-900000');
  baseSnapshot=(await mockPool.query(`SELECT source_id,ada_code,name,phone,source_payload,payload_hash FROM ada_history.customers ORDER BY ada_code`)).rows;
 },30000);
 afterAll(async()=>{
  if(mockPool)try{
   if(baseSnapshot){
    const original=(await mockPool.query(`SELECT source_id,ada_code,name,phone,source_payload,payload_hash FROM ada_history.customers WHERE ada_code='AR005-900000'`)).rows;
    expect(original).toEqual(baseSnapshot);
    expect((await mockPool.query('SELECT count(*)::int n FROM point_ledger')).rows[0].n).toBe(0);
   }
  }finally{await mockPool.end();}
  for(const key of Object.keys(process.env))if(!(key in oldEnv))delete process.env[key];Object.assign(process.env,oldEnv);
 });
 test('paid receipt is stored with a pending SCM member and no Ada balance, and history is immediately readable',async()=>{
  const id=await member(),value=body(id),response=await send(value);
  expect(response.status).toBe(201);expect(response.body).toMatchObject({historyFirst:true,sccrmStored:true,historyRecorded:true,pointsCredited:false,newPointsBalance:null,pointsAvailable:false,syncState:'pending'});
  expect((await jobFor(response.body.claimId)).member_id).toBe(id);
  const history=await auth('get','/api/members/'+id+'/purchase-history');
  expect(history.status).toBe(200);expect(history.body.purchases[0]).toMatchObject({receiptNo:value.receiptNo,posCode:'002',totalAmount:100,awardedPoints:null,pointsAvailable:false,
   items:[{productCode:'SKU-FIXTURE',barcode:'8850000000001',unitCode:'BOX',unitName:'กล่อง',qty:2,unitPrice:50,lineTotal:100}]});
  expect(new Date(history.body.purchases[0].soldAt).toISOString()).toBe('2026-11-11T02:10:11.000Z');
  const status=await auth('get','/api/loyalty/claims/status?branchCode=005&receiptNo='+value.receiptNo);
  expect(status.body).toMatchObject({claimed:true,historyFirstEnabled:true,member:{id}});
 });
 test('lost acknowledgements, concurrent submissions and a different member never duplicate or move the bill',async()=>{
  const id=await member(),other=await member(),value=body(id);
  const answers=await Promise.all(Array.from({length:4},()=>send(value)));
  expect(answers.map(a=>a.status).sort()).toEqual([201,409,409,409]);
  expect((await send({...value,memberId:other})).status).toBe(409);
  expect((await mockPool.query('SELECT user_id FROM loyalty_claims WHERE receipt_no=$1',[value.receiptNo])).rows).toEqual([{user_id:id}]);
  const claim=answers.find(a=>a.status===201).body.claimId;
  expect((await mockPool.query('SELECT count(*)::int n FROM sccrm_receipt_sync.jobs WHERE claim_id=$1',[claim])).rows[0].n).toBe(1);
 });
 test('line/queue failures roll back the receipt and mirror rather than falsely reporting success',async()=>{
  const id=await member(),value=body(id);
  await mockPool.query(`ALTER TABLE loyalty_claim_items ADD CONSTRAINT refuse_fixture_sku CHECK(product_code<>'FORCE-FAIL') NOT VALID`);
  try{expect((await send({...value,items:[{...value.items[0],productCode:'FORCE-FAIL'}]})).status).toBe(500);}finally{await mockPool.query('ALTER TABLE loyalty_claim_items DROP CONSTRAINT refuse_fixture_sku');}
  expect((await mockPool.query('SELECT count(*)::int n FROM loyalty_claims WHERE receipt_no=$1',[value.receiptNo])).rows[0].n).toBe(0);
  await mockPool.query('UPDATE sccrm_receipt_sync.meta SET enabled=false');
  try{const response=await send(value);expect(response.status).toBe(503);}finally{await mockPool.query('UPDATE sccrm_receipt_sync.meta SET enabled=true');}
  expect((await mockPool.query('SELECT count(*)::int n FROM crm_pos_sale_events WHERE doc_no=$1',[value.receiptNo])).rows[0].n).toBe(0);
 });
 test('registration and its member outbox commit together before Ada receives anything',async()=>{
  const response=await auth('post','/api/members').send({name:'Synthetic New Signup',phone:'0998000001'});
  expect(response.status).toBe(201);expect(response.body.memberCode).toMatch(/^SCM-/);expect(response.body.pointsAvailable).toBe(false);
  expect((await mockPool.query('SELECT kind,origin_branch,state FROM sccrm_receipt_sync.jobs WHERE member_id=$1',[response.body.id])).rows).toEqual([{kind:'member',origin_branch:'005',state:'pending'}]);
 });
 test('HQ and each branch have separate evidence; an offline branch does not block another job',async()=>{
  const id=await member(),code='AR000-900001',assignment=crypto.randomUUID();await link(id,code);
  await mockPool.query('INSERT INTO sccrm_member_codes.assignments(assignment_id,member_id,ada_code,deliver_to_branches) VALUES($1,$2,$3,true)',[assignment,id,code]);
  for(const branch of ['001','003','004']){
   await mockPool.query("INSERT INTO sccrm_member_codes.jobs(target_id,assignment_id,state,last_code) VALUES($1,$2,'succeeded',NULL)",[branch,assignment]);
   await mockPool.query('INSERT INTO sccrm_member_codes.mappings VALUES($1,$2,$3,$4)',[branch,assignment,id,code]);
  }
  const jobId=await outbox.enqueue(mockPool,{memberId:id,branchCode:'005'});
  let observed=await outbox.observeMember(mockPool,{member_id:id});expect(observed).toMatchObject({state:'retry',code:'WAITING_FOR_BRANCHES',evidence:{hqReady:true}});
  expect(observed.evidence.branches.filter(b=>b.ready)).toHaveLength(3);
  const independent=await member();await link(independent,'AR003-900002');
  expect((await outbox.observeMember(mockPool,{member_id:independent})).state).toBe('succeeded');
  await mockPool.query("INSERT INTO sccrm_member_codes.jobs(target_id,assignment_id,state,last_code) VALUES('005',$1,'succeeded',NULL)",[assignment]);
  await mockPool.query("INSERT INTO sccrm_member_codes.mappings VALUES('005',$1,$2,$3)",[assignment,id,code]);
  observed=await outbox.observeMember(mockPool,{member_id:id});expect(observed.state).toBe('succeeded');
  expect(observed.evidence.branches.every(b=>b.ready)).toBe(true);expect(jobId).toMatch(/^[a-f0-9-]{36}$/);
 });
 test('expired leases recover after restart and a delayed old worker cannot acknowledge the new lease',async()=>{
  const a=await outbox.lease(mockPool);expect(a).not.toBeNull();
  await mockPool.query("UPDATE sccrm_receipt_sync.jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[a.id]);
  const b=await outbox.lease(mockPool);expect(b.id).toBe(a.id);expect(b.lease_token).not.toBe(a.lease_token);
  expect(await outbox.finish(mockPool,a,{state:'succeeded',code:'ADA_RECEIPT_VERIFIED'})).toBe(false);
  expect(await outbox.finish(mockPool,b,{state:'retry',code:'WAITING_FOR_HQ'})).toBe(true);
  expect((await mockPool.query("SELECT count(*)::int n FROM sccrm_receipt_sync.events WHERE job_id=$1 AND code='EXPIRED_LEASE_RECOVERED'",[a.id])).rows[0].n).toBe(1);
 });
 test('sanitized logs and retry are staff-only and branch-bound, without accepting changed receipt/member data',async()=>{
  const id=await member(),response=await send(body(id)),job=await jobFor(response.body.claimId);
  expect((await request(app).get('/api/loyalty/sync-jobs')).status).toBe(401);
  const details=await auth('get','/api/loyalty/sync-jobs/'+job.id);expect(details.status).toBe(200);expect(details.body.events[0].code).toBe('SCCRM_STORED');
  expect((await auth('get','/api/loyalty/sync-jobs/'+job.id,otherToken)).status).toBe(404);
  expect((await auth('post','/api/loyalty/sync-jobs/'+job.id+'/retry',otherToken).send({})).status).toBe(404);
  expect((await auth('post','/api/loyalty/sync-jobs/'+job.id+'/retry').send({memberId:crypto.randomUUID()})).status).toBe(400);
  expect((await auth('post','/api/loyalty/sync-jobs/'+job.id+'/retry').send({})).status).toBe(200);
  expect((await auth('post','/api/loyalty/sync-jobs/'+job.id+'/retry').send({})).status).toBe(409);
  expect((await jobFor(response.body.claimId)).member_id).toBe(id);
 });
 test('source outages retry automatically and preserve already recorded history',async()=>{
  const before=(await mockPool.query('SELECT count(*)::int n FROM loyalty_claims')).rows[0].n;
  const result=await outbox.runOnce(mockPool,{limit:3,inspect:async()=>{throw Error('synthetic source offline');}});
  expect(result.processed).toBeGreaterThan(0);
  expect((await mockPool.query("SELECT count(*)::int n FROM sccrm_receipt_sync.jobs WHERE last_code='SYNC_SOURCE_UNAVAILABLE' AND state='retry'")).rows[0].n).toBeGreaterThan(0);
  expect((await mockPool.query('SELECT count(*)::int n FROM loyalty_claims')).rows[0].n).toBe(before);
 });
 test('job identity and append-only audit cannot be silently rewritten',async()=>{
  const row=(await mockPool.query('SELECT id FROM sccrm_receipt_sync.jobs LIMIT 1')).rows[0];
  await expect(mockPool.query('UPDATE sccrm_receipt_sync.jobs SET member_id=$2 WHERE id=$1',[row.id,crypto.randomUUID()])).rejects.toThrow('SYNC_JOB_IDENTITY_IMMUTABLE');
  await expect(mockPool.query("UPDATE sccrm_receipt_sync.events SET code='SCCRM_STORED' WHERE job_id=$1",[row.id])).rejects.toThrow('SYNC_AUDIT_IMMUTABLE');
 });
 test('native delivery starts once origin branch is ready, without waiting for another offline branch',async()=>{
  const id=await member(),code='AR000-900003',assignment=crypto.randomUUID();await link(id,code);
  await mockPool.query('INSERT INTO sccrm_member_codes.assignments(assignment_id,member_id,ada_code,deliver_to_branches) VALUES($1,$2,$3,true)',[assignment,id,code]);
  await mockPool.query("INSERT INTO sccrm_member_codes.jobs(target_id,assignment_id,state,last_code) VALUES('005',$1,'succeeded',NULL)",[assignment]);
  await mockPool.query("INSERT INTO sccrm_member_codes.mappings VALUES('005',$1,$2,$3)",[assignment,id,code]);
  const value=body(id),saved=await send(value),job=await jobFor(saved.body.claimId);
  const status=await outbox.observe(mockPool,job);expect(status.code).toBe('WAITING_FOR_ADA_RECEIPT_DELIVERY');
  expect(status.evidence.branches.filter(b=>b.ready)).toHaveLength(1);
  const delivery=require('../lib/sccrmReceiptDelivery');
  const a=(await delivery.lease(mockPool,{targetBranch:'005'})).job;
  const hq=(await delivery.lease(mockPool,{targetBranch:'000'})).job;
  expect(a.payload).toMatchObject({memberId:id,adaCode:code,receiptNo:value.receiptNo,posCode:'002'});
  expect(hq.id).not.toBe(a.id);
  await mockPool.query("UPDATE sccrm_receipt_sync.native_deliveries SET lease_until=now()-interval '1 second' WHERE id=$1",[a.id]);
  const b=(await delivery.lease(mockPool,{targetBranch:'005'})).job;
  expect(b.id).toBe(a.id);expect(b.leaseToken).not.toBe(a.leaseToken);
  const ack=j=>({id:j.id,targetBranch:j.targetBranch,leaseToken:j.leaseToken,payloadHash:j.payloadHash,state:'succeeded',code:'ADA_RECEIPT_VERIFIED',
   proof:{operationId:j.id,payloadHash:j.payloadHash,adaCode:code,receiptNo:value.receiptNo,branchCode:'005',posCode:'002',targetBranch:j.targetBranch,
    tables:['TPSTSalHD'],outcome:'replayed',verifiedAt:new Date().toISOString()}});
  expect((await delivery.acknowledge(mockPool,ack(a))).accepted).toBe(false);
  await expect(delivery.acknowledge(mockPool,{...ack(b),proof:{...ack(b).proof,adaCode:'AR000-999999'}})).rejects.toThrow('RECEIPT_WORKER_PACKET_REFUSED');
  expect((await delivery.acknowledge(mockPool,ack(b))).accepted).toBe(true);
  expect((await outbox.observe(mockPool,job)).state).toBe('retry');
  await delivery.acknowledge(mockPool,ack(hq));
  expect((await outbox.observe(mockPool,job)).state).toBe('succeeded');
  expect((await mockPool.query('SELECT count(*)::int n FROM sccrm_receipt_sync.native_deliveries WHERE parent_id=$1',[job.id])).rows[0].n).toBe(2);
  await expect(mockPool.query('UPDATE sccrm_receipt_sync.native_deliveries SET payload=$2 WHERE id=$1',[b.id,{memberId:crypto.randomUUID()}])).rejects.toThrow('NATIVE_RECEIPT_IDENTITY_IMMUTABLE');
 });
 test('web directory logs resolve the exact canonical member and show immutable registration/native branch events',async()=>{
  const logs=require('../lib/sccrmSyncLog'),id=await member();await link(id,'AR000-900004');
  const response=await send(body(id)),job=await jobFor(response.body.claimId);await outbox.observe(mockPool,job);
  const summary=(await logs.summaries(mockPool,[id])).get(id);expect(summary).toMatchObject({hqReady:true,adaCode:'AR000-900004'});
  const detail=await logs.detail(mockPool,id);expect(detail.member.id).toBe(id);expect(detail.jobs[0].receiptNo).toBeTruthy();
  expect(detail.events.some(e=>e.code==='SCCRM_STORED')).toBe(true);
  await expect(logs.retry(mockPool,crypto.randomUUID(),{jobId:job.id,actor:{id:'synthetic-admin',role:'admin'}})).rejects.toMatchObject({status:404});
 });
 test('final Ada time replaces only the existing origin claim time; immutable input, owner, lines and points survive replay and lost ACK',async()=>{
  const delivery=require('../lib/sccrmReceiptDelivery');
  await mockPool.query("UPDATE sccrm_receipt_sync.native_deliveries SET next_attempt_at=now()+interval '1 hour',lease_until=CASE WHEN state='running' THEN now()+interval '1 hour' ELSE NULL END");
  const id=await member(),code='AR000-900005';await link(id,code);
  const value=body(id),saved=await send(value),job=await jobFor(saved.body.claimId);
  await outbox.observe(mockPool,job);
  const frozen=(await mockPool.query('SELECT id,payload,payload_hash FROM sccrm_receipt_sync.native_deliveries WHERE parent_id=$1 ORDER BY id',[job.id])).rows;
  const items=(await mockPool.query('SELECT * FROM loyalty_claim_items WHERE claim_id=$1',[saved.body.claimId])).rows;
  const original=new Date(value.soldAt).toISOString(),final='2026-11-11T02:15:42.000Z';
  const ack=(j,time)=>({id:j.id,targetBranch:j.targetBranch,leaseToken:j.leaseToken,payloadHash:j.payloadHash,state:'succeeded',code:'ADA_RECEIPT_VERIFIED',proof:{
   operationId:j.id,payloadHash:j.payloadHash,adaCode:code,receiptNo:value.receiptNo,branchCode:'005',posCode:'002',targetBranch:j.targetBranch,
   tables:['TPSTSalHD'],outcome:'replayed',verifiedAt:new Date().toISOString(),timePolicy:'ada-final-time-v1',submittedSoldAt:j.payload.soldAt,nativeSoldAt:time,timeAdjusted:Date.parse(time)!==Date.parse(j.payload.soldAt),nativeTimeTable:'TPSTSalHD'}});
  // The HQ observation must never replace the actual origin's time.
  const hq=(await delivery.lease(mockPool,{targetBranch:'000',timePolicy:'ada-final-time-v1'})).job;
  expect((await delivery.acknowledge(mockPool,ack(hq,'2026-11-11T02:16:00.000Z'))).accepted).toBe(true);
  const claim=async()=>(await mockPool.query('SELECT user_id,sold_at FROM loyalty_claims WHERE id=$1',[saved.body.claimId])).rows[0];
  expect((await claim()).sold_at.toISOString()).toBe(original);
  const a=(await delivery.lease(mockPool,{targetBranch:'005',timePolicy:'ada-final-time-v1'})).job;
  await mockPool.query("UPDATE sccrm_receipt_sync.native_deliveries SET lease_until=now()-interval '1 second' WHERE id=$1",[a.id]);
  const b=(await delivery.lease(mockPool,{targetBranch:'005',timePolicy:'ada-final-time-v1'})).job;
  expect((await delivery.acknowledge(mockPool,ack(a,final))).accepted).toBe(false);
  expect((await claim()).sold_at.toISOString()).toBe(original);
  await expect(delivery.acknowledge(mockPool,{...ack(b,final),proof:{...ack(b,final).proof,submittedSoldAt:final}})).rejects.toThrow('RECEIPT_WORKER_PACKET_REFUSED');
  expect((await delivery.acknowledge(mockPool,ack(b,final))).accepted).toBe(true);
  expect((await delivery.acknowledge(mockPool,ack(b,final))).accepted).toBe(false);
  expect(await claim()).toMatchObject({user_id:id});expect((await claim()).sold_at.toISOString()).toBe(final);
  expect((await mockPool.query("SELECT sale_at FROM crm_pos_sale_events WHERE raw_payload->>'loyalty_claim_id'=$1",[saved.body.claimId])).rows[0].sale_at.toISOString()).toBe(final);
  expect((await mockPool.query('SELECT id,payload,payload_hash FROM sccrm_receipt_sync.native_deliveries WHERE parent_id=$1 ORDER BY id',[job.id])).rows).toEqual(frozen);
  expect((await mockPool.query('SELECT * FROM loyalty_claim_items WHERE claim_id=$1',[saved.body.claimId])).rows).toEqual(items);
  const observed=await outbox.observe(mockPool,job);expect(observed.state).toBe('succeeded');
  expect(observed.evidence.receiptTime).toMatchObject({originalSccrmTime:original,claimTimeBeforeAdoption:original,adaFinalTime:final,adjusted:true});
  expect((await mockPool.query("SELECT count(*)::int n FROM sccrm_receipt_sync.events WHERE job_id=$1 AND code='ADA_FINAL_TIME_ADOPTED'",[job.id])).rows[0].n).toBe(1);
  expect((await mockPool.query('SELECT count(*)::int n FROM point_ledger')).rows[0].n).toBe(0);
 });
 test('upgraded workers automatically recheck old time holds once, while real owner/financial conflicts remain held',async()=>{
  const delivery=require('../lib/sccrmReceiptDelivery');
  await mockPool.query("UPDATE sccrm_receipt_sync.native_deliveries SET next_attempt_at=now()+interval '1 hour',lease_until=CASE WHEN state='running' THEN now()+interval '1 hour' ELSE NULL END");
  const id=await member();await link(id,'AR000-900006');
  const saved=await send(body(id)),job=await jobFor(saved.body.claimId);await outbox.observe(mockPool,job);
  await mockPool.query("UPDATE sccrm_receipt_sync.native_deliveries SET state='review',last_code='RECEIPT_HEADER_CHANGED' WHERE parent_id=$1 AND target_branch='005'",[job.id]);
  await mockPool.query("UPDATE sccrm_receipt_sync.jobs SET state='review',last_code='ADA_RECEIPT_REQUIRES_REVIEW' WHERE id=$1",[job.id]);
  expect((await delivery.lease(mockPool,{targetBranch:'005'})).job).toBeNull();
  const leased=(await delivery.lease(mockPool,{targetBranch:'005',timePolicy:'ada-final-time-v1'})).job;expect(leased.payload.jobId).toBe(job.id);
  await delivery.acknowledge(mockPool,{id:leased.id,targetBranch:'005',leaseToken:leased.leaseToken,payloadHash:leased.payloadHash,state:'retry',code:'RECEIPT_NOT_FINAL'});
  await mockPool.query('UPDATE sccrm_receipt_sync.native_deliveries SET next_attempt_at=now() WHERE id=$1',[leased.id]);
  const retried=(await delivery.lease(mockPool,{targetBranch:'005',timePolicy:'ada-final-time-v1'})).job;expect(retried.id).toBe(leased.id);
  await delivery.acknowledge(mockPool,{id:retried.id,targetBranch:'005',leaseToken:retried.leaseToken,payloadHash:retried.payloadHash,state:'review',code:'RECEIPT_FINANCIAL_HEADER_CHANGED'});
  await mockPool.query("UPDATE sccrm_receipt_sync.jobs SET state='review',last_code='ADA_RECEIPT_REQUIRES_REVIEW' WHERE id=$1",[job.id]);
  expect((await delivery.lease(mockPool,{targetBranch:'005',timePolicy:'ada-final-time-v1'})).job).toBeNull();
  expect((await mockPool.query("SELECT count(*)::int n FROM sccrm_receipt_sync.events WHERE job_id=$1 AND code='ADA_FINAL_TIME_POLICY_RECHECK'",[job.id])).rows[0].n).toBe(1);
  expect((await mockPool.query('SELECT state,last_code FROM sccrm_receipt_sync.native_deliveries WHERE id=$1',[leased.id])).rows[0]).toEqual({state:'review',last_code:'RECEIPT_FINANCIAL_HEADER_CHANGED'});
 });
 test('final suffix recovery appends lines once, preserves the original audit and fences old deliveries without awarding points',async()=>{
  const repair=require('../lib/sccrmReceiptFinalRevision'),delivery=require('../lib/sccrmReceiptDelivery');
  const id=await member(),code='AR000-900007';await link(id,code);
  const value=body(id,'S2611005002-9999001'),saved=await send(value),claimId=saved.body.claimId,job=await jobFor(claimId);
  await outbox.observe(mockPool,job);
  await mockPool.query("UPDATE sccrm_receipt_sync.native_deliveries SET state='review',last_code='RECEIPT_FINANCIAL_HEADER_CHANGED' WHERE parent_id=$1",[job.id]);
  await mockPool.query("UPDATE sccrm_receipt_sync.jobs SET state='review',last_code='ADA_RECEIPT_REQUIRES_REVIEW' WHERE id=$1",[job.id]);
  const original=(await mockPool.query('SELECT * FROM loyalty_claims WHERE id=$1',[claimId])).rows[0];
  const oldLines=(await mockPool.query('SELECT * FROM loyalty_claim_items WHERE claim_id=$1 ORDER BY id',[claimId])).rows;
  const oldDeliveries=(await mockPool.query('SELECT id,payload,payload_hash FROM sccrm_receipt_sync.native_deliveries WHERE parent_id=$1 ORDER BY id',[job.id])).rows;
  const final={...original.receipt_snapshot,totalAmount:125,receiptDiscount:5,items:[...original.receipt_snapshot.items,
   {...original.receipt_snapshot.items[0],seq:2,productCode:'SECOND-SKU',qty:1,unitPrice:30,lineTotal:30}]};
  const packet={policy:'ada-final-missing-suffix-v1',claimId,memberId:id,adaCode:code,branchCode:'005',posCode:'002',receiptNo:value.receiptNo,
   originalSnapshot:original.receipt_snapshot,finalSnapshot:final,nativeProof:{originBranch:'005',pos:'002',doc:value.receiptNo,paid:'3',documentStatus:'1',
    sourceAndHqMatch:true,stableReadCount:2,nativeJournalCount:0,paymentRows:1,paymentNet:125,rounding:0,snapshotHash:repair.hash(final)}};
  await expect(repair.recover(mockPool,{...packet,memberId:crypto.randomUUID()})).rejects.toThrow('RECEIPT_RECOVERY_OWNER');
  await expect(repair.recover(mockPool,{...packet,nativeProof:{...packet.nativeProof,paymentNet:100}})).rejects.toThrow('RECEIPT_RECOVERY_FINAL_PROOF');
  await expect(repair.recover(mockPool,{...packet,finalSnapshot:{...final,items:[{...final.items[0],qty:20},final.items[1]]}})).rejects.toThrow('RECEIPT_RECOVERY_NOT_EXACT_PREFIX');
  expect(await repair.recover(mockPool,packet)).toMatchObject({revision:2,appendedLines:1,replayed:false});
  expect(await repair.recover(mockPool,packet)).toMatchObject({revision:2,replayed:true});
  expect((await mockPool.query('SELECT * FROM loyalty_claim_items WHERE id=$1',[oldLines[0].id])).rows).toEqual(oldLines);
  expect((await mockPool.query('SELECT count(*)::int n FROM loyalty_claim_items WHERE claim_id=$1',[claimId])).rows[0].n).toBe(2);
  expect((await mockPool.query('SELECT id,payload,payload_hash FROM sccrm_receipt_sync.native_deliveries WHERE parent_id=$1 AND revision=1 ORDER BY id',[job.id])).rows).toEqual(oldDeliveries);
  const revision=(await mockPool.query('SELECT * FROM sccrm_receipt_sync.final_revisions WHERE claim_id=$1',[claimId])).rows[0];
  expect(revision.original_claim.receipt_snapshot).toEqual(original.receipt_snapshot);expect(revision.final_snapshot).toEqual(final);
  await expect(mockPool.query('UPDATE sccrm_receipt_sync.final_revisions SET packet_hash=$2 WHERE claim_id=$1',[claimId,'a'.repeat(64)])).rejects.toThrow('SYNC_AUDIT_IMMUTABLE');
  await mockPool.query("UPDATE sccrm_receipt_sync.native_deliveries SET state='pending',next_attempt_at=now() WHERE parent_id=$1 AND revision=1",[job.id]);
  // Suppress unrelated fixtures; only this receipt is eligible for this check.
  await mockPool.query("UPDATE sccrm_receipt_sync.native_deliveries SET next_attempt_at=now()+interval '1 hour' WHERE parent_id<>$1",[job.id]);
  for(const target of ['005','000']){
   const leased=(await delivery.lease(mockPool,{targetBranch:target})).job;
   expect(leased.payload.totalAmount).toBe(125);expect(leased.payload.items).toHaveLength(2);expect(oldDeliveries.some(d=>d.id===leased.id)).toBe(false);
   const proof={operationId:leased.id,payloadHash:leased.payloadHash,adaCode:code,receiptNo:value.receiptNo,branchCode:'005',posCode:'002',targetBranch:target,
    tables:['TPSTSalHD'],outcome:'replayed',verifiedAt:new Date().toISOString()};
   expect((await delivery.acknowledge(mockPool,{id:leased.id,targetBranch:target,leaseToken:leased.leaseToken,payloadHash:leased.payloadHash,state:'succeeded',code:'ADA_RECEIPT_VERIFIED',proof})).accepted).toBe(true);
  }
  expect((await outbox.observe(mockPool,job)).state).toBe('succeeded');
  expect((await mockPool.query('SELECT count(*)::int n FROM loyalty_claims WHERE id=$1',[claimId])).rows[0].n).toBe(1);
  expect((await mockPool.query('SELECT count(*)::int n FROM point_ledger')).rows[0].n).toBe(0);
 });
 test('a late legacy zero-price import cannot overwrite a cashier-confirmed receipt or its member/history',async()=>{
  const id=await member(),value=body(id),saved=await send(value),claimId=saved.body.claimId;
  const mirror=async()=>(await mockPool.query("SELECT * FROM crm_pos_sale_events WHERE raw_payload->>'loyalty_claim_id'=$1",[claimId])).rows[0];
  const original=await mirror(),lines=(await mockPool.query('SELECT * FROM crm_pos_sale_line_events WHERE sale_event_id=$1 ORDER BY line_no',[original.id])).rows;
  process.env.SCCRM_INTERNAL_API_TOKEN='synthetic-late-import-token';
  const result=await request(app).post('/internal/crm/pos/sales').set('x-internal-token',process.env.SCCRM_INTERNAL_API_TOKEN).send({records:[{
   branch_code:value.branchCode,doc_no:value.receiptNo,pos_code:null,net_total:0,paid_total:0,source_system:'AdaAcc',source_event_key:original.source_event_key,
   line_rows:[{line_no:1,product_code:'WRONG-LEGACY-PROJECTION',qty:50,net_amount:0}]}]});
  expect(result.status).toBe(200);expect(await mirror()).toEqual(original);
  expect((await mockPool.query('SELECT * FROM crm_pos_sale_line_events WHERE sale_event_id=$1 ORDER BY line_no',[original.id])).rows).toEqual(lines);
  expect((await mockPool.query('SELECT user_id FROM loyalty_claims WHERE id=$1',[claimId])).rows[0].user_id).toBe(id);
 });
 test('completeness repairs a stored bill without units, preserves identity and points, and committed replay is idempotent',async()=>{
  const r=require('../lib/sccrmReceiptCompleteness'),policy=require('../lib/receiptCompletenessPolicy').POLICY;
  const id=await member(),value=body(id);value.items[0].unitCode=null;value.items[0].unitName=null;
  const saved=await send(value),claimId=saved.body.claimId;expect(saved.status).toBe(201);
  expect((await mockPool.query('SELECT state FROM sccrm_receipt_sync.completeness WHERE claim_id=$1',[claimId])).rows[0].state).toBe('pending');
  await link(id,'AR005-998001');await mockPool.query('UPDATE sccrm_receipt_sync.completeness_control SET enabled=true');
  await mockPool.query("UPDATE sccrm_receipt_sync.completeness SET next_check_at=now()+interval '1 day' WHERE claim_id<>$1",[claimId]);
  const job=(await r.lease(mockPool,{originBranch:'005',policy})).job;expect(job.id).toBe(claimId);
  const observed=target=>({policy,targetBranch:target,stableReadCount:2,table:'TPSTSalHD',memberMatches:true,walkInVerified:false,journals:[],
   header:{branchCode:'005',posCode:'002',receiptNo:value.receiptNo,adaCode:'',docType:'1',paidStatus:'3',documentStatus:'1',totalAmount:100,receiptDiscount:0,rounding:0,docDate:'2026-11-11',docTime:'09:10:11'},
   items:[{...value.items[0],unitCode:'BOX',unitName:'กล่อง',lineDiscount:0,promotionCode:null}],payments:[{seq:1,code:'cash',amount:100,net:100,change:0}]});
  const packet={id:job.id,leaseToken:job.leaseToken,baselineHash:job.baselineHash,policy,source:observed('005'),hq:observed('000')};
  const before=(await mockPool.query('SELECT * FROM loyalty_claim_items WHERE claim_id=$1',[claimId])).rows;
  const replies=await Promise.all([r.acknowledge(mockPool,packet),r.acknowledge(mockPool,packet)]);
  expect(replies.every(x=>x.accepted)).toBe(true);expect(replies.some(x=>x.replayed)).toBe(true);
  expect((await mockPool.query('SELECT * FROM loyalty_claim_items WHERE claim_id=$1',[claimId])).rows).toEqual(before);
  expect((await mockPool.query('SELECT receipt_snapshot,user_id FROM loyalty_claims WHERE id=$1',[claimId])).rows[0]).toMatchObject({user_id:id,receipt_snapshot:{items:[{unitCode:'BOX',unitName:'กล่อง'}]}});
  expect((await mockPool.query('SELECT count(*)::int n FROM sccrm_receipt_sync.completeness_audit WHERE claim_id=$1',[claimId])).rows[0].n).toBe(1);
  expect((await mockPool.query('SELECT count(*)::int n FROM point_ledger')).rows[0].n).toBe(0);
  // The history view's mirror is also reconciled, even if the claim snapshot is already complete.
  const mirrorId=(await mockPool.query("SELECT id FROM crm_pos_sale_events WHERE raw_payload->>'loyalty_claim_id'=$1",[claimId])).rows[0].id;
  await mockPool.query('UPDATE crm_pos_sale_line_events SET unit_name=NULL WHERE sale_event_id=$1',[mirrorId]);
  await mockPool.query('UPDATE sccrm_receipt_sync.completeness SET next_check_at=now() WHERE claim_id=$1',[claimId]);
  const mirrorLease=(await r.lease(mockPool,{originBranch:'005',policy})).job;
  expect((await r.acknowledge(mockPool,{...packet,leaseToken:mirrorLease.leaseToken,baselineHash:mirrorLease.baselineHash})).code).toBe('RECON_FILLED');
  expect((await mockPool.query('SELECT unit_name FROM crm_pos_sale_line_events WHERE sale_event_id=$1',[mirrorId])).rows[0].unit_name).toBe('กล่อง');
  // A later native mutation is found by a newly leased periodic audit and never overwrites the saved unit.
  await mockPool.query('UPDATE sccrm_receipt_sync.completeness SET next_check_at=now() WHERE claim_id=$1',[claimId]);
  const next=(await r.lease(mockPool,{originBranch:'005',policy})).job;expect(next.leaseToken).not.toBe(job.leaseToken);
  const changed={...packet,leaseToken:next.leaseToken,baselineHash:next.baselineHash,source:observed('005'),hq:observed('000')};changed.source.items[0].unitCode=changed.hq.items[0].unitCode='BOTTLE';
  expect((await r.acknowledge(mockPool,changed)).state).toBe('review');
  expect((await mockPool.query("SELECT receipt_snapshot#>>'{items,0,unitCode}' unit FROM loyalty_claims WHERE id=$1",[claimId])).rows[0].unit).toBe('BOX');
 });
 test('completeness expired leases, stale snapshots and an offline source cannot duplicate or switch a claim',async()=>{
  const r=require('../lib/sccrmReceiptCompleteness'),policy=require('../lib/receiptCompletenessPolicy').POLICY,id=await member(),saved=await send(body(id)),claimId=saved.body.claimId;
  await link(id,'AR005-998002');await mockPool.query("UPDATE sccrm_receipt_sync.completeness SET next_check_at=now()+interval '1 day' WHERE claim_id<>$1",[claimId]);
  const old=(await r.lease(mockPool,{originBranch:'005',policy})).job;
  await mockPool.query("UPDATE sccrm_receipt_sync.completeness SET lease_until=now()-interval '1 second' WHERE claim_id=$1",[claimId]);
  const fresh=(await r.lease(mockPool,{originBranch:'005',policy})).job;
  const failure=j=>({id:j.id,leaseToken:j.leaseToken,baselineHash:j.baselineHash,policy,errorCode:'RECON_SOURCE_UNAVAILABLE'});
  expect((await r.acknowledge(mockPool,failure(old))).accepted).toBe(false);
  expect((await r.acknowledge(mockPool,failure(fresh))).state).toBe('retry');
  expect((await mockPool.query('SELECT count(*)::int n FROM loyalty_claims WHERE id=$1',[claimId])).rows[0].n).toBe(1);
  expect((await mockPool.query('SELECT user_id FROM loyalty_claims WHERE id=$1',[claimId])).rows[0].user_id).toBe(id);
 });
 test('an older producer deployment gap is enrolled without duplicating the existing receipt or its job',async()=>{
  const r=require('../lib/sccrmReceiptCompleteness'),policy=require('../lib/receiptCompletenessPolicy').POLICY,id=await member(),saved=await send(body(id)),claimId=saved.body.claimId;
  await link(id,'AR005-998003');await mockPool.query('DELETE FROM sccrm_receipt_sync.completeness WHERE claim_id=$1',[claimId]);
  await mockPool.query('UPDATE sccrm_receipt_sync.completeness_control SET pilot_claims=$1',[[claimId]]);
  expect((await r.lease(mockPool,{originBranch:'005',policy})).job.id).toBe(claimId);
  expect((await mockPool.query('SELECT count(*)::int n FROM loyalty_claims WHERE id=$1',[claimId])).rows[0].n).toBe(1);
  expect((await mockPool.query('SELECT count(*)::int n FROM sccrm_receipt_sync.jobs WHERE claim_id=$1',[claimId])).rows[0].n).toBe(1);
 });
 test('receipt worker uses a separate narrow machine credential and never accepts altered lease scope',async()=>{
  const url='/internal/sccrm-receipt-sync/lease';
  expect((await request(app).post(url).send({targetBranch:'005'})).status).toBe(401);
  for(const action of ['completeness-lease','completeness-acknowledge'])expect((await request(app).post('/internal/sccrm-receipt-sync/'+action).set('Authorization','Bearer '+token).send({})).status).toBe(401);
  expect((await request(app).post(url).set('Authorization','Bearer '+token).send({targetBranch:'005'})).status).toBe(401);
  const secret=process.env.SC_OFFICIAL_RECEIPT_WORKER_TOKEN;
  expect((await request(app).post(url).set('x-sccrm-receipt-worker',secret).send({targetBranch:'005',memberId:crypto.randomUUID()})).status).toBe(400);
  const response=await request(app).post(url).set('x-sccrm-receipt-worker',secret).send({targetBranch:'000'});
  expect(response.status).toBe(200);expect(response.body.ok).toBe(true);
  expect(JSON.stringify(response.body)).not.toContain(secret);
 });
});
