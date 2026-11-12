'use strict';
// Two private, real receipt fixtures; local PostgreSQL and guarded native copies only.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{Pool}=require('pg');
async function run(){
 const url=new URL(process.env.SCCRM_COMPLETENESS_TEST_DATABASE_URL||'');
 assert(['localhost','127.0.0.1'].includes(url.hostname)&&url.port==='55442'&&/^\/crm_history_first_test_completeness_real2_/.test(url.pathname));
 const native=path.resolve(process.env.SCCRM_COMPLETENESS_NATIVE_COPY||'');assert(native.endsWith('native-receipt-completeness-20261112'));
 const root=path.join(native,'sync-agent/receipts/runtime/completeness-20261112'),before=JSON.parse(fs.readFileSync(path.join(root,'baseline-two.json')));
 assert.equal(before.cases.length,2);const {createReconciler,stableRead}=require(path.join(native,'sync-agent/receipts/completeness.cjs')),
  {receive}=require(path.join(native,'sync-agent/receipts/native-adapter.cjs')),{readAdmin}=require(path.join(native,'sync-agent/fanout/admin-source.cjs')),
  copy=require(path.join(native,'sync-agent/receipts/time-copy.cjs')),r=require('../lib/sccrmReceiptCompleteness'),delivery=require('../lib/sccrmReceiptDelivery'),outbox=require('../lib/sccrmHistoryFirst');
 process.env.SC_OFFICIAL_ADA_POINTS_MODE='ada-primary';process.env.SC_OFFICIAL_SCCRM_HISTORY_FIRST_ENABLED='true';
 const db=new Pool({connectionString:url.toString(),max:3});const admin=readAdmin('000');let counter=0;const nativeApplied=[];
 try{
  assert.equal(Number((await db.query('SELECT count(*) n FROM loyalty_claims')).rows[0].n),0);
  await db.query("INSERT INTO sccrm_receipt_sync.meta(singleton,marker,scope,schema_version,enabled)VALUES(true,'9bde36f3-a235-4228-9e6f-190126a213f5','SCCRM-HISTORY-FIRST-V1',1,true)");
  await db.query("INSERT INTO sccrm_receipt_sync.completeness_control(singleton,marker,enabled)VALUES(true,'ba30ffae-036c-4b7c-a276-8eb8f5474768',true)");
  const user=async id=>db.query('INSERT INTO users(id,full_name,phone_number)VALUES($1,$2,$3)ON CONFLICT(id)DO NOTHING',[id,'Isolated copied receipt owner','09998'+String(++counter).padStart(5,'0')]);
  const insert=async(table,rows)=>{for(const row of rows)await db.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table},$1::jsonb)`,[row]);};
  for(const b of before.cases){await user(b.claim.user_id);await db.query('INSERT INTO member_profiles(user_id,member_code)VALUES($1,$2)',[b.claim.user_id,b.member_code]);
   const profile=b.deliveries[0].payload;await db.query(`INSERT INTO ada_history.customers(source_id,ada_code,name,phone,active,source_payload,payload_hash,source_snapshot)
    VALUES('hq000/AdaAcc',$1,$2,$3,'1',$4,$5,$6)`,[b.member_code,profile.expectedName,profile.expectedPhone,{FTCstCode:b.member_code},'a'.repeat(64),require('node:crypto').randomUUID()]);
   await db.query("INSERT INTO ada_history.member_links VALUES($1,'hq000/AdaAcc',$2,'isolated copied approval')",[b.claim.user_id,b.member_code]);
   await insert('loyalty_claims',[b.claim]);await insert('loyalty_claim_items',b.items);await insert('sccrm_receipt_sync.jobs',[b.job]);await insert('sccrm_receipt_sync.native_deliveries',b.deliveries);
   for(const m of b.mirrors){await insert('crm_pos_sale_events',[m.header]);await insert('crm_pos_sale_line_events',m.items);}await r.enqueue(db,b.job.id);
  }
  for(const p of before.points){await user(p.user_id);await insert('point_ledger',[p]);}
  const points=async()=>(await db.query('SELECT * FROM point_ledger ORDER BY id')).rows,oldPoints=await points();
  const targets=['000','001','003','004','005'].map(branch=>({...copy.target('000',copy.databaseFor(branch)),branch})),credentials=Object.fromEntries(targets.map(t=>[t.branch,admin]));
  const api=async(action,body)=>action==='completeness-lease'?r.lease(db,body):action==='completeness-acknowledge'?r.acknowledge(db,body):action==='lease'?delivery.lease(db,body):delivery.acknowledge(db,body);
  const status=[],worker=createReconciler({api,targets,credentials,reader:(t,c,j)=>stableRead(t,c,j,{mode:'Copy'}),onStatus:s=>status.push(s)});
  await worker.cycle('005');await worker.cycle('005');
  const results=[];
  for(const b of before.cases){const actual=(await db.query('SELECT * FROM loyalty_claims WHERE id=$1',[b.claim.id])).rows[0],state=(await db.query('SELECT state,code FROM sccrm_receipt_sync.completeness WHERE claim_id=$1',[b.claim.id])).rows[0];
   assert.equal(state.state,'verified',state.code);assert(actual.receipt_snapshot.items.every(i=>i.unitCode&&i.unitName));assert.equal(actual.user_id,b.claim.user_id);assert.equal(Number(actual.total_amount),Number(b.claim.total_amount));assert.equal(Number(actual.awarded_points),Number(b.claim.awarded_points));
   const lines=(await db.query('SELECT * FROM loyalty_claim_items WHERE claim_id=$1',[b.claim.id])).rows;
   assert.equal(lines.length,b.items.length);for(const old of b.items){const current=lines.find(i=>i.id===old.id);assert(current);for(const k of ['product_code','product_name'])assert.equal(current[k],old[k]);for(const k of ['qty','unit_price','line_total'])assert.equal(Number(current[k]),Number(old[k]));}
   const ds=(await db.query('SELECT * FROM sccrm_receipt_sync.native_deliveries WHERE parent_id=$1 ORDER BY revision,target_branch',[b.job.id])).rows;
   assert.equal(ds.length,4);for(const old of b.deliveries){const current=ds.find(d=>d.id===old.id);assert.deepEqual(current.payload,old.payload);assert.equal(current.payload_hash,old.payload_hash);}
   results.push({doc:b.claim.receipt_no,adaCode:b.member_code,total:actual.receipt_snapshot.totalAmount,units:actual.receipt_snapshot.items.map(i=>i.unitName),ownerAndOriginalLineIdsPreserved:true});
  }
  // Commit and replay native operations in the guarded copies, so the later
  // periodic audit observes the same committed owner as a real deployment.
  for(const targetBranch of ['005','000'])for(let n=0;n<2;n++){
   const job=(await delivery.lease(db,{targetBranch})).job;assert(job);const target=targets.find(t=>t.branch===targetBranch),owners=[];
   for(const table of ['TPSTSalHD','TSHD'+job.payload.posCode]){const found=copy.sql(target,"SELECT OBJECT_ID(@table) id",{table:'dbo.'+table},{copy:true}).results[0][0].id;if(found){const rows=copy.sql(target,`SELECT FTCstCode FROM dbo.${table} WHERE FTBchCode=@branch AND FTShdDocNo=@doc`,{branch:job.payload.branchCode,doc:job.payload.receiptNo},{copy:true}).results[0];if(rows.length)owners.push({table,code:rows[0].FTCstCode});}}
   nativeApplied.push({target,job,owners});const proof=await receive(target,admin,job,{mode:'Copy'});const replay=await receive(target,admin,job,{mode:'Copy'});assert.equal(replay.outcome,'replayed');
   assert.equal(copy.sql(target,'SELECT COUNT(*) n FROM dbo.SCCRM_ReceiptSyncJournal WHERE operation_id=@id',{id:job.id},{copy:true}).results[0][0].n,1);
   const packet={id:job.id,targetBranch,leaseToken:job.leaseToken,payloadHash:job.payloadHash,state:'succeeded',code:'ADA_RECEIPT_VERIFIED',proof};assert((await delivery.acknowledge(db,packet)).accepted);
  }
  // Re-run a later audit through the same worker, not a special recovery SQL.
  await db.query('UPDATE sccrm_receipt_sync.completeness SET next_check_at=now()');await worker.cycle('005');await worker.cycle('005');
  assert.equal(Number((await db.query("SELECT count(*) n FROM sccrm_receipt_sync.completeness WHERE state='verified'")).rows[0].n),2);
  assert.equal(Number((await db.query('SELECT count(*) n FROM sccrm_receipt_sync.completeness_audit')).rows[0].n),2);
  assert.equal(Number((await db.query('SELECT count(*) n FROM loyalty_claims')).rows[0].n),2);assert.deepEqual(await points(),oldPoints);
  for(const b of before.cases)assert.equal((await outbox.observe(db,b.job)).state,'succeeded');
  const proof={ok:true,results,pointRowsUnchanged:oldPoints.length,noDuplicateClaims:true,repeatedWorkerAudits:true,nativeCopyTargets:4,productionWrites:0};
  fs.writeFileSync(path.join(root,'real-two-end-to-end.json'),JSON.stringify(proof,null,2));return proof;
 }finally{
  // Remove only operations created by this test and restore those copied
  // owner fields; never delete a pre-existing native customer, sale or point.
  for(const {target,job,owners} of nativeApplied){
   copy.sql(target,'DELETE dbo.SCCRM_ReceiptTimeAudit WHERE operation_id=@id;DELETE dbo.SCCRM_ReceiptSyncJournal WHERE operation_id=@id',{id:job.id},{copy:true,transaction:true});
   for(const old of owners)copy.sql(target,`UPDATE dbo.${old.table} SET FTCstCode=@code WHERE FTBchCode=@branch AND FTShdDocNo=@doc AND FTCstCode=@expected`,{code:old.code,branch:job.payload.branchCode,doc:job.payload.receiptNo,expected:job.payload.adaCode},{copy:true});
  }
  admin.password='';await db.end();
 }
}
if(require.main===module)run().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.log(JSON.stringify({ok:false,code:e.code||e.message,copyDetail:e.copySqlMessage}));process.exitCode=1;});
module.exports={run};
