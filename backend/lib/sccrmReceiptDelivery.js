'use strict';
const {randomUUID,createHash,timingSafeEqual}=require('node:crypto');
const TARGETS=['000','001','003','004','005'];
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CODE=/^[A-Z][A-Z0-9_]{2,79}$/;
const TIME_POLICY='ada-final-time-v1';
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
 const revision=Number((await db.query(`SELECT greatest(COALESCE((SELECT MAX(revision) FROM sccrm_receipt_sync.final_revisions WHERE claim_id=$1),1),COALESCE((SELECT MAX(revision) FROM sccrm_receipt_sync.native_deliveries WHERE parent_id=$2),1))::int revision`,[claim.id || job.claim_id,job.id])).rows[0].revision);
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
  await db.query(`INSERT INTO sccrm_receipt_sync.native_deliveries(id,parent_id,target_branch,payload,payload_hash,revision)
   VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(parent_id,target_branch,revision) DO NOTHING`,[id,job.id,target,payload,hash,revision]);
 }
 const rows=(await db.query(`SELECT target_branch,state,last_code,proof,payload FROM sccrm_receipt_sync.native_deliveries WHERE parent_id=$1 AND revision=$2 ORDER BY target_branch`,[job.id,revision])).rows;
 const evidence={...member.evidence,nativeReceipts:rows.map(r=>({branchCode:r.target_branch,state:r.state,code:r.last_code||null,verifiedAt:r.proof?.verifiedAt||null}))};
 const origin=rows.find(r=>r.target_branch===job.origin_branch);
 if(origin?.proof?.timePolicy===TIME_POLICY)evidence.receiptTime={policy:TIME_POLICY,
  originalSccrmTime:origin.proof.submittedSoldAt,claimTimeBeforeAdoption:origin.proof.claimSoldAtBefore||null,
  adaFinalTime:origin.proof.nativeSoldAt,adjusted:origin.proof.timeAdjusted,verifiedAt:origin.proof.verifiedAt};
 if(rows.some(r=>r.payload.memberId!==job.member_id||r.payload.adaCode!==member.evidence.adaCode||r.payload.receiptNo!==claim.receipt_no))return {state:'review',code:'RECEIPT_IDENTITY_CONFLICT',evidence};
 if(rows.some(r=>r.state==='review'))return {state:'review',code:'ADA_RECEIPT_REQUIRES_REVIEW',evidence};
 if(rows.length===2&&rows.every(r=>r.state==='succeeded'))return {state:'succeeded',code:'ADA_RECEIPT_VERIFIED',evidence:{...evidence,adaReceiptReady:true}};
 return {state:'retry',code:'WAITING_FOR_ADA_RECEIPT_DELIVERY',evidence};
}
async function lease(db,body){
 if(!body||Object.keys(body).some(k=>!['targetBranch','timePolicy'].includes(k))||!TARGETS.includes(body.targetBranch)
   ||body.timePolicy!==undefined&&body.timePolicy!==TIME_POLICY)throw invalid();
 if(!await require('./sccrmHistoryFirst').available(db))return {ok:true,job:null};
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  // Only the upgraded, authenticated worker requests this one-time recheck.
  // Old HEADER_CHANGED combined time/amount/state; the new native receiver
  // still rejects every real financial/owner/item mismatch under distinct codes.
  if(body.timePolicy===TIME_POLICY)await recoverLegacyTimeReviews(c,body.targetBranch);
  const row=(await c.query(`SELECT d.* FROM sccrm_receipt_sync.native_deliveries d
   WHERE target_branch=$1 AND ((state IN('pending','retry') AND next_attempt_at<=now()) OR(state='running' AND lease_until<now()))
   AND NOT EXISTS(SELECT 1 FROM sccrm_receipt_sync.native_deliveries newer WHERE newer.parent_id=d.parent_id AND newer.target_branch=d.target_branch AND newer.revision>d.revision)
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
async function recoverLegacyTimeReviews(c,target){
 const changed=(await c.query(`WITH candidates AS (
  SELECT d.id FROM sccrm_receipt_sync.native_deliveries d JOIN sccrm_receipt_sync.jobs j ON j.id=d.parent_id
  WHERE d.target_branch=$1 AND d.state='review' AND d.last_code='RECEIPT_HEADER_CHANGED'
   AND j.kind='receipt' AND j.state='review' AND j.last_code='ADA_RECEIPT_REQUIRES_REVIEW'
   AND NOT EXISTS(SELECT 1 FROM sccrm_receipt_sync.native_deliveries bad WHERE bad.parent_id=j.id
    AND bad.state='review' AND bad.last_code IS DISTINCT FROM 'RECEIPT_HEADER_CHANGED')
   AND NOT EXISTS(SELECT 1 FROM sccrm_receipt_sync.events e WHERE e.job_id=j.id AND e.target_branch=d.target_branch AND e.code='ADA_FINAL_TIME_POLICY_RECHECK')
  ORDER BY d.created_at,d.id FOR UPDATE OF d SKIP LOCKED LIMIT 25
 ) UPDATE sccrm_receipt_sync.native_deliveries d SET state='pending',last_code='ADA_FINAL_TIME_POLICY_RECHECK',
  next_attempt_at=now(),lease_token=NULL,lease_until=NULL,updated_at=now()
  FROM candidates x WHERE d.id=x.id RETURNING d.parent_id,d.target_branch`,[target])).rows;
 for(const row of changed){
  await c.query(`INSERT INTO sccrm_receipt_sync.events(job_id,state,code,target_branch)VALUES($1,'pending','ADA_FINAL_TIME_POLICY_RECHECK',$2)`,[row.parent_id,row.target_branch]);
  await c.query(`UPDATE sccrm_receipt_sync.jobs SET state='pending',last_code='ADA_FINAL_TIME_POLICY_RECHECK',next_attempt_at=now(),
   updated_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$1 AND state='review' AND last_code='ADA_RECEIPT_REQUIRES_REVIEW'`,[row.parent_id]);
 }
}
function validTimeProof(p,payload){
 const fields=['timePolicy','submittedSoldAt','nativeSoldAt','timeAdjusted','nativeTimeTable'];
 if(!fields.some(k=>Object.hasOwn(p,k)))return true; // Rolling compatibility with the old worker.
 return fields.every(k=>Object.hasOwn(p,k))&&p.timePolicy===TIME_POLICY&&typeof p.timeAdjusted==='boolean'
  &&Number.isFinite(Date.parse(p.nativeSoldAt))&&Date.parse(p.submittedSoldAt)===Date.parse(payload.soldAt)
  &&p.timeAdjusted===(Date.parse(p.nativeSoldAt)!==Date.parse(payload.soldAt))&&p.tables.includes(p.nativeTimeTable);
}
async function adoptOriginTime(c,row,p){
 if(p.timePolicy!==TIME_POLICY||row.target_branch!==row.payload.branchCode)return;
 const payload=row.payload;
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`ada-points-receipt:${payload.branchCode}:${payload.receiptNo}`]);
 const claim=(await c.query(`SELECT lc.id,lc.user_id::text AS member_id,lc.branch_code,lc.receipt_no,lc.sold_at
  FROM public.loyalty_claims lc JOIN sccrm_receipt_sync.jobs j ON j.claim_id=lc.id
  WHERE j.id=$1 AND j.member_id=lc.user_id::uuid FOR UPDATE OF lc`,[row.parent_id])).rows[0];
 if(!claim||claim.member_id!==payload.memberId||claim.branch_code!==payload.branchCode||claim.receipt_no!==payload.receiptNo)throw invalid();
 const before=claim.sold_at?new Date(claim.sold_at).toISOString():null,final=new Date(p.nativeSoldAt).toISOString();
 await c.query(`UPDATE public.loyalty_claims SET sold_at=$2 WHERE id=$1 AND user_id::uuid=$3::uuid`,[claim.id,final,payload.memberId]);
 // Update only the existing SCCRM mirror explicitly tied to this same claim.
 // No receipt/line/award creation and no change to its owner, items or points.
 await c.query(`UPDATE public.crm_pos_sale_events SET sale_at=$2,updated_at=now()
  WHERE branch_code=$3 AND doc_no=$4 AND raw_payload->>'loyalty_claim_id'=$1`,[String(claim.id),final,payload.branchCode,payload.receiptNo]);
 await c.query(`UPDATE sccrm_receipt_sync.native_deliveries SET proof=$2 WHERE id=$1`,[row.id,{...p,claimSoldAtBefore:before}]);
 await c.query(`INSERT INTO sccrm_receipt_sync.events(job_id,state,code,target_branch)VALUES($1,'succeeded',$2,$3)`,
  [row.parent_id,Date.parse(before)===Date.parse(final)?'ADA_FINAL_TIME_VERIFIED':'ADA_FINAL_TIME_ADOPTED',row.target_branch]);
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
  if((await c.query('SELECT 1 FROM sccrm_receipt_sync.native_deliveries WHERE parent_id=$1 AND target_branch=$2 AND revision>$3',[row.parent_id,row.target_branch,row.revision])).rows.length){await c.query('COMMIT');return {ok:true,accepted:false};}
  const p=body.proof;
  if(body.state==='succeeded'&&(!p||Object.keys(p).some(k=>!['operationId','payloadHash','adaCode','receiptNo','branchCode','posCode','targetBranch','tables','outcome','verifiedAt','timePolicy','submittedSoldAt','nativeSoldAt','timeAdjusted','nativeTimeTable'].includes(k))
   ||p.operationId!==row.id||p.payloadHash!==row.payload_hash||p.adaCode!==row.payload.adaCode
   ||p.receiptNo!==row.payload.receiptNo||p.branchCode!==row.payload.branchCode||p.posCode!==row.payload.posCode
   ||p.targetBranch!==body.targetBranch||!Array.isArray(p.tables)||!p.tables.length||p.tables.length>2
   ||p.tables.some(t=>!['TSHD'+row.payload.posCode,'TPSTSalHD'].includes(t))
   ||!['applied','replayed','already_linked'].includes(p.outcome)||!Number.isFinite(Date.parse(p.verifiedAt))||!validTimeProof(p,row.payload)))throw invalid();
  const result=await c.query(`UPDATE sccrm_receipt_sync.native_deliveries SET state=$3,last_code=$4,proof=$5,
   next_attempt_at=now()+make_interval(secs=>least(300,5*greatest(1,attempt_count))),updated_at=now(),lease_token=NULL,lease_until=NULL
   WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>now() RETURNING parent_id`,[row.id,body.leaseToken,body.state,body.code,body.state==='succeeded'?p:null]);
  if(result.rows.length){
   if(body.state==='succeeded')await adoptOriginTime(c,row,p);
   await c.query(`INSERT INTO sccrm_receipt_sync.events(job_id,state,code,target_branch)VALUES($1,$2,$3,$4)`,[row.parent_id,body.state,body.code,body.targetBranch]);
   await c.query(`UPDATE sccrm_receipt_sync.jobs SET next_attempt_at=now() WHERE id=$1 AND state IN('pending','retry')`,[row.parent_id]);
  }
  await c.query('COMMIT');require('./sccrmHistoryFirst').notify();return {ok:true,accepted:result.rows.length===1};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function retry(db,parentId){
 await db.query(`UPDATE sccrm_receipt_sync.native_deliveries SET state='pending',next_attempt_at=now(),updated_at=now(),
  lease_token=NULL,lease_until=NULL WHERE parent_id=$1 AND state IN('retry','review') AND NOT EXISTS(SELECT 1 FROM sccrm_receipt_sync.native_deliveries newer WHERE newer.parent_id=native_deliveries.parent_id AND newer.target_branch=native_deliveries.target_branch AND newer.revision>native_deliveries.revision)`,[parentId]);
}
module.exports={authorize,schedule,lease,acknowledge,retry};
