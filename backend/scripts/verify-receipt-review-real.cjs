'use strict';
// Private real-data fixtures and disposable local PostgreSQL only. No native SQL,
// network API, child process or production connection is used by this test.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),os=require('node:os'),{Pool}=require('pg');
const {plan}=require('../lib/receiptCompletenessPolicy'),{mirrorPlan}=require('../lib/receiptMirrorCompleteness'),r=require('../lib/sccrmReceiptCompleteness');
async function run(){
 const started=Date.now(),url=new URL(process.env.SCCRM_REVIEW_TEST_DATABASE_URL||'');
 assert(['localhost','127.0.0.1'].includes(url.hostname)&&url.port==='55442'&&/^\/crm_history_first_test_review22_/.test(url.pathname));
 const root=path.resolve(process.env.SCCRM_REVIEW_FIXTURE_ROOT||'');assert(root.endsWith('completeness-20261112'));
 const fixture=JSON.parse(fs.readFileSync(path.join(root,'review22-baseline.json'),'utf8'));assert.equal(fixture.cases.length,22);
 const native=Object.fromEntries(['000','004','005'].map(b=>[b,JSON.parse(fs.readFileSync(path.join(root,'review22-native-'+b+'.json'),'utf8'))]));
 process.env.SC_OFFICIAL_ADA_POINTS_MODE='ada-primary';process.env.SC_OFFICIAL_SCCRM_HISTORY_FIRST_ENABLED='true';
 const db=new Pool({connectionString:url.toString(),max:2}),seen=new Set();let sequence=0;
 const insert=async(table,rows)=>{for(const row of rows)await db.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table},$1::jsonb)`,[row]);};
 const user=async(id,name='Copied ledger identity')=>{if(seen.has(id))return;seen.add(id);await db.query('INSERT INTO users(id,full_name,phone_number)VALUES($1,$2,$3)',[id,name,'09970'+String(++sequence).padStart(5,'0')]);};
 const snapshot=async(table,order='id')=>(await db.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows;
 try{
  assert.equal(Number((await db.query('SELECT count(*) n FROM loyalty_claims')).rows[0].n),0,'Empty disposable copy required');
  await db.query("INSERT INTO sccrm_receipt_sync.meta(singleton,marker,scope,schema_version,enabled)VALUES(true,'9bde36f3-a235-4228-9e6f-190126a213f5','SCCRM-HISTORY-FIRST-V1',1,true)");
  await db.query("INSERT INTO sccrm_receipt_sync.completeness_control(singleton,marker,enabled)VALUES(true,'ba30ffae-036c-4b7c-a276-8eb8f5474768',true)");
  for(const v of fixture.cases){await user(v.claim.user_id,v.name);
   await db.query('INSERT INTO member_profiles(user_id,member_code)VALUES($1,$2)ON CONFLICT DO NOTHING',[v.claim.user_id,v.memberCode]);
   await db.query(`INSERT INTO ada_history.customers(source_id,ada_code,name,phone,active,source_payload,payload_hash,source_snapshot)
    VALUES('hq000/AdaAcc',$1,$2,$3,'1',$4,$5,$6)ON CONFLICT DO NOTHING`,[v.linkedCode,v.expectedName,v.expectedPhone,{FTCstCode:v.linkedCode},'a'.repeat(64),crypto.randomUUID()]);
   await db.query("INSERT INTO ada_history.member_links VALUES($1,'hq000/AdaAcc',$2,'isolated copied approval')ON CONFLICT DO NOTHING",[v.claim.user_id,v.linkedCode]);
   await insert('loyalty_claims',[v.claim]);await insert('loyalty_claim_items',v.items);await insert('sccrm_receipt_sync.jobs',[v.job]);
   if(v.deliveries?.length)await insert('sccrm_receipt_sync.native_deliveries',v.deliveries);
   for(const m of v.mirrors){await insert('crm_pos_sale_events',[m.header]);await insert('crm_pos_sale_line_events',m.items);}
   await insert('sccrm_receipt_sync.completeness',[v.reconciliation]);
  }
  for(const p of fixture.points){await user(p.user_id);await insert('point_ledger',[p]);}
  const original={claims:await snapshot('loyalty_claims'),items:await snapshot('loyalty_claim_items'),points:await snapshot('point_ledger'),deliveries:await snapshot('sccrm_receipt_sync.native_deliveries'),mirrors:await snapshot('crm_pos_sale_events'),mirrorLines:await snapshot('crm_pos_sale_line_events')};
  const results=[];
  for(const v of fixture.cases){
   await db.query("UPDATE sccrm_receipt_sync.completeness_control SET pilot_claims=$1",[[v.claim.id]]);
   await db.query("UPDATE sccrm_receipt_sync.completeness SET state='pending',next_check_at=now() WHERE claim_id=$1",[v.claim.id]);
   const job=(await r.lease(db,{originBranch:v.claim.branch_code,policy:'ada-receipt-completeness-v1'})).job;assert.equal(job.id,v.claim.id);
   const source=native[v.claim.branch_code].observations.find(n=>n.claimId===v.claim.id),hq=native['000'].observations.find(n=>n.claimId===v.claim.id);
   const packet={id:job.id,leaseToken:job.leaseToken,baselineHash:job.baselineHash,policy:job.policy,source,hq};
   const ack=await r.acknowledge(db,packet);assert((await r.acknowledge(db,packet)).replayed,'Lost reply must replay without another write');
   if(v.reconciliation.code==='RECON_OTHER_OWNER'){
    assert.equal(ack.state,'review');assert.equal(ack.code,'RECON_OTHER_OWNER');
    const current=(await snapshot('crm_pos_sale_events')).find(m=>m.id===v.mirrors[0].header.id);
    assert.deepEqual(current,original.mirrors.find(m=>m.id===current.id));
    assert.deepEqual((await snapshot('crm_pos_sale_line_events')).filter(l=>l.sale_event_id===current.id),original.mirrorLines.filter(l=>l.sale_event_id===current.id));
   }else{
    assert.equal(ack.state,'verified',ack.code);assert.equal(ack.code,'RECON_FILLED');
    const mirror=(await db.query('SELECT * FROM crm_pos_sale_events WHERE id=$1',[v.mirrors[0].header.id])).rows[0];
    const lines=(await db.query('SELECT * FROM crm_pos_sale_line_events WHERE sale_event_id=$1 ORDER BY line_no',[mirror.id])).rows;
    assert.equal(Number(mirror.net_total),v.claim.receipt_total_amount);assert.equal(mirror.raw_payload.loyalty_claim_id,v.claim.id);
    assert.deepEqual(lines.map(l=>l.id).sort(),v.mirrors[0].items.map(l=>l.id).sort(),'Original mirror line IDs preserved');
    assert.deepEqual(lines.map(l=>l.line_no),v.claim.receipt_snapshot.items.map(i=>i.seq));
    assert.equal(Number((await db.query('SELECT count(*) n FROM sccrm_receipt_sync.completeness_audit WHERE claim_id=$1',[v.claim.id])).rows[0].n),1);
    await db.query('UPDATE sccrm_receipt_sync.completeness SET next_check_at=now() WHERE claim_id=$1',[v.claim.id]);
    const again=(await r.lease(db,{originBranch:v.claim.branch_code,policy:job.policy})).job;
    assert.equal((await r.acknowledge(db,{...packet,leaseToken:again.leaseToken,baselineHash:again.baselineHash})).code,'RECON_VERIFIED');
    assert.equal(Number((await db.query('SELECT count(*) n FROM sccrm_receipt_sync.completeness_audit WHERE claim_id=$1',[v.claim.id])).rows[0].n),1);
   }
   results.push({doc:v.claim.receipt_no,state:ack.state,code:ack.code});
  }
  assert.deepEqual(await snapshot('loyalty_claims'),original.claims);assert.deepEqual(await snapshot('loyalty_claim_items'),original.items);
  assert.deepEqual(await snapshot('point_ledger'),original.points);assert.deepEqual(await snapshot('sccrm_receipt_sync.native_deliveries'),original.deliveries);
  const v=fixture.cases.find(v=>v.mirrors[0].header.source_system==='AdaAcc'),source=native[v.claim.branch_code].observations.find(n=>n.claimId===v.claim.id),hq=native['000'].observations.find(n=>n.claimId===v.claim.id);
  const identity={memberId:v.claim.user_id,branchCode:v.claim.branch_code,posCode:v.job.origin_pos,receiptNo:v.claim.receipt_no,adaCode:v.linkedCode},p=plan(v.claim.receipt_snapshot,source,hq,identity);
  for(const mutate of [m=>{m.header.ada_customer_code='AR000-999999';},m=>{m.header.raw_payload.loyalty_claim_id=crypto.randomUUID();},m=>{m.items[0].net_amount=1;},m=>{m.items[0].barcode='WRONG';},m=>{m.items[0].qty=999;}]){
   const m=structuredClone(v.mirrors[0]);mutate(m);assert.throws(()=>mirrorPlan(m.header,m.items,v.claim,p,identity));
  }
  assert.throws(()=>mirrorPlan(v.mirrors[0].header,v.mirrors[0].items,v.claim,{...p,sourceOwned:false},identity));
  const peakBytes=process.resourceUsage().maxRSS*1024,elapsedMs=Date.now()-started;assert(peakBytes<=256*1024*1024&&elapsedMs<60000,'LIGHT_TEST resource budget exceeded');
  const proof={ok:true,host:os.hostname(),pid:process.pid,executable:process.execPath,elapsedMs,peakProcessWorkingSetBytes:peakBytes,results,repaired:results.filter(r=>r.state==='verified').length,held:results.filter(r=>r.state==='review').length,pointsUnchanged:original.points.length,claimAndLineIdsUnchanged:true,nativeRequestsUnchanged:true,repeatDoesNotDuplicateAudit:true,productionWrites:0,pinRead:false};
  fs.writeFileSync(path.join(root,'review22-copy-proof.json'),JSON.stringify(proof,null,2));return proof;
 }finally{await db.end();}
}
if(require.main===module)run().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.log(JSON.stringify({ok:false,code:e.code||e.message,message:e.message}));process.exitCode=1;});
module.exports={run};
