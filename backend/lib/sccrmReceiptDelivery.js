'use strict';
const {randomUUID,createHash,timingSafeEqual}=require('node:crypto');
const TARGETS=['000','001','003','004','005'];
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CODE=/^[A-Z][A-Z0-9_]{2,79}$/;
function invalid(){return Object.assign(Error('RECEIPT_WORKER_PACKET_REFUSED'),{status:400});}
function authorize(req,res,next){
 const expected=process.env.SC_OFFICIAL_RECEIPT_WORKER_TOKEN||'',provided=req.get('x-sccrm-receipt-worker')||'';
 const a=Buffer.from(expected),b=Buffer.from(provided);
 if(a.length<32||b.length!==a.length||!timingSafeEqual(a,b))return res.status(401).json({ok:false,error:'Unauthorized'});
 return next();
}
async function schedule(db,job,claim,member){
 const snapshot=claim.receipt_snapshot;
 if(!/^\d{3}$/.test(job.origin_pos||'')||!snapshot||snapshot.posCode!==job.origin_pos
   ||snapshot.totalAmountSource!=='pos_header'||!claim.sold_at||!Array.isArray(snapshot.items)||!snapshot.items.length){
  return {state:'review',code:'RECEIPT_SNAPSHOT_INCOMPLETE',evidence:member.evidence};
 }
 const profile=(await db.query(`SELECT name,phone FROM ada_history.customers WHERE source_id='hq000/AdaAcc' AND ada_code=$1`,[member.evidence.adaCode])).rows[0];
 if(!profile)return {state:'retry',code:'WAITING_FOR_HQ',evidence:member.evidence};
 for(const target of [job.origin_branch,'000']){
  const id=randomUUID();
  const payload={version:1,operationId:id,jobId:job.id,memberId:job.member_id,adaCode:member.evidence.adaCode,
   branchCode:job.origin_branch,posCode:job.origin_pos,receiptNo:claim.receipt_no,
   soldAt:new Date(claim.sold_at).toISOString(),totalAmount:snapshot.totalAmount,
   items:snapshot.items,lineAdjustments:snapshot.lineAdjustments||null,
   expectedName:profile.name,expectedPhone:profile.phone||null};
  const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  await db.query(`INSERT INTO sccrm_receipt_sync.native_deliveries(id,parent_id,target_branch,payload,payload_hash)
   VALUES($1,$2,$3,$4,$5) ON CONFLICT(parent_id,target_branch) DO NOTHING`,[id,job.id,target,payload,hash]);
 }
 const rows=(await db.query(`SELECT target_branch,state,last_code,proof,payload FROM sccrm_receipt_sync.native_deliveries WHERE parent_id=$1 ORDER BY target_branch`,[job.id])).rows;
 const evidence={...member.evidence,nativeReceipts:rows.map(r=>({branchCode:r.target_branch,state:r.state,code:r.last_code||null,verifiedAt:r.proof?.verifiedAt||null}))};
 if(rows.some(r=>r.payload.memberId!==job.member_id||r.payload.adaCode!==member.evidence.adaCode||r.payload.receiptNo!==claim.receipt_no))return {state:'review',code:'RECEIPT_IDENTITY_CONFLICT',evidence};
 if(rows.some(r=>r.state==='review'))return {state:'review',code:'ADA_RECEIPT_REQUIRES_REVIEW',evidence};
 if(rows.length===2&&rows.every(r=>r.state==='succeeded'))return {state:'succeeded',code:'ADA_RECEIPT_VERIFIED',evidence:{...evidence,adaReceiptReady:true}};
 return {state:'retry',code:'WAITING_FOR_ADA_RECEIPT_DELIVERY',evidence};
}
async function lease(db,body){
 if(!body||Object.keys(body).some(k=>k!=='targetBranch')||!TARGETS.includes(body.targetBranch))throw invalid();
 if(!await require('./sccrmHistoryFirst').available(db))return {ok:true,job:null};
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const row=(await c.query(`SELECT d.* FROM sccrm_receipt_sync.native_deliveries d
   WHERE target_branch=$1 AND ((state IN('pending','retry') AND next_attempt_at<=now()) OR(state='running' AND lease_until<now()))
   AND EXISTS(SELECT 1 FROM sccrm_receipt_sync.jobs j WHERE j.id=d.parent_id AND j.state<>'review')
   ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,[body.targetBranch])).rows[0];
  if(!row){await c.query('COMMIT');return {ok:true,job:null};}
  const token=randomUUID();
  await c.query(`UPDATE sccrm_receipt_sync.native_deliveries SET state='running',lease_token=$2,lease_until=now()+interval '45 seconds',
   attempt_count=attempt_count+1,updated_at=now() WHERE id=$1`,[row.id,token]);
  await c.query(`INSERT INTO sccrm_receipt_sync.events(job_id,state,code,target_branch) VALUES($1,'running',$2,$3)`,[row.parent_id,row.state==='running'?'NATIVE_LEASE_RECOVERED':'SENDING_ADA_RECEIPT',row.target_branch]);
  await c.query('COMMIT');
  return {ok:true,job:{id:row.id,targetBranch:row.target_branch,leaseToken:token,payloadHash:row.payload_hash,payload:row.payload}};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function acknowledge(db,body){
 if(!body||Object.keys(body).some(k=>!['id','targetBranch','leaseToken','payloadHash','state','code','proof'].includes(k))
  ||!UUID.test(body.id||'')||!UUID.test(body.leaseToken||'')||!TARGETS.includes(body.targetBranch)
  ||!['succeeded','retry','review'].includes(body.state)||!CODE.test(body.code||'')||!/^[a-f0-9]{64}$/.test(body.payloadHash||''))throw invalid();
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const row=(await c.query(`SELECT * FROM sccrm_receipt_sync.native_deliveries WHERE id=$1 AND target_branch=$2 FOR UPDATE`,[body.id,body.targetBranch])).rows[0];
  if(!row||row.payload_hash!==body.payloadHash)throw invalid();
  const p=body.proof;
  if(body.state==='succeeded'&&(!p||Object.keys(p).some(k=>!['operationId','payloadHash','adaCode','receiptNo','branchCode','posCode','targetBranch','tables','outcome','verifiedAt'].includes(k))
   ||p.operationId!==row.id||p.payloadHash!==row.payload_hash||p.adaCode!==row.payload.adaCode
   ||p.receiptNo!==row.payload.receiptNo||p.branchCode!==row.payload.branchCode||p.posCode!==row.payload.posCode
   ||p.targetBranch!==body.targetBranch||!Array.isArray(p.tables)||!p.tables.length||p.tables.length>2
   ||p.tables.some(t=>!['TSHD'+row.payload.posCode,'TPSTSalHD'].includes(t))
   ||!['applied','replayed','already_linked'].includes(p.outcome)||!Number.isFinite(Date.parse(p.verifiedAt))))throw invalid();
  const result=await c.query(`UPDATE sccrm_receipt_sync.native_deliveries SET state=$3,last_code=$4,proof=$5,
   next_attempt_at=now()+make_interval(secs=>least(300,5*greatest(1,attempt_count))),updated_at=now(),lease_token=NULL,lease_until=NULL
   WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>now() RETURNING parent_id`,[row.id,body.leaseToken,body.state,body.code,body.state==='succeeded'?p:null]);
  if(result.rows.length){
   await c.query(`INSERT INTO sccrm_receipt_sync.events(job_id,state,code,target_branch)VALUES($1,$2,$3,$4)`,[row.parent_id,body.state,body.code,body.targetBranch]);
   await c.query(`UPDATE sccrm_receipt_sync.jobs SET next_attempt_at=now() WHERE id=$1 AND state IN('pending','retry')`,[row.parent_id]);
  }
  await c.query('COMMIT');require('./sccrmHistoryFirst').notify();return {ok:true,accepted:result.rows.length===1};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function retry(db,parentId){
 await db.query(`UPDATE sccrm_receipt_sync.native_deliveries SET state='pending',next_attempt_at=now(),updated_at=now(),
  lease_token=NULL,lease_until=NULL WHERE parent_id=$1 AND state IN('retry','review')`,[parentId]);
}
module.exports={authorize,schedule,lease,acknowledge,retry};
