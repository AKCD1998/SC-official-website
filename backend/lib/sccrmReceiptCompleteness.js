'use strict';
const {randomUUID}=require('node:crypto');
const {isDeepStrictEqual:equal}=require('node:util');
const {POLICY,hash,plan}=require('./receiptCompletenessPolicy');
const {mirrorPlan}=require('./receiptMirrorCompleteness');
const branches=['001','003','004','005'],uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const invalid=()=>Object.assign(Error('RECON_PACKET_REFUSED'),{status:400});
const transient=new Set(['RECON_SOURCE_NOT_FINAL','RECON_PAYMENT_INCOMPLETE','RECON_SOURCE_FIELDS_INCOMPLETE','RECON_SOURCE_TIME_INCOMPLETE','RECON_SOURCE_HQ_DIFFERENT','RECON_SOURCE_UNAVAILABLE','RECON_SOURCE_RETRY','RECON_SOURCE_NOT_ARRIVED','RECON_MEMBER_REQUIRES_REVIEW']);
async function enqueue(c,job){
 await c.query(`INSERT INTO sccrm_receipt_sync.completeness(claim_id,job_id,origin_branch) SELECT claim_id,id,origin_branch
  FROM sccrm_receipt_sync.jobs WHERE id=$1 AND kind='receipt' ON CONFLICT(claim_id) DO NOTHING`,[job]);
}
async function lease(db,body){
 if(!body||Object.keys(body).some(k=>!['originBranch','policy'].includes(k))||!branches.includes(body.originBranch)||body.policy!==POLICY)throw invalid();
 if(!await require('./sccrmHistoryFirst').available(db))return {ok:true,job:null};
 const c=await db.connect();try{
  await c.query('BEGIN');
  const control=(await c.query("SELECT enabled,pilot_claims FROM sccrm_receipt_sync.completeness_control WHERE singleton=true AND marker='ba30ffae-036c-4b7c-a276-8eb8f5474768'")).rows[0];
  if(!control?.enabled){await c.query('COMMIT');return {ok:true,job:null};}
  // Also close a rolling-deployment gap if an older backend saved a claim
  // between this additive migration and the new producer deployment.
  await c.query(`INSERT INTO sccrm_receipt_sync.completeness(claim_id,job_id,origin_branch)
   SELECT j.claim_id,j.id,j.origin_branch FROM sccrm_receipt_sync.jobs j WHERE j.kind='receipt' AND j.origin_branch=$1
    AND NOT EXISTS(SELECT 1 FROM sccrm_receipt_sync.completeness r WHERE r.claim_id=j.claim_id) ON CONFLICT DO NOTHING`,[body.originBranch]);
  const row=(await c.query(`SELECT r.*,lc.receipt_no,lc.receipt_snapshot,lc.user_id::text member_id,j.origin_pos,
   p.member_code,l.ada_code,a.name expected_name,a.phone expected_phone
   FROM sccrm_receipt_sync.completeness r JOIN public.loyalty_claims lc ON lc.id=r.claim_id
   JOIN sccrm_receipt_sync.jobs j ON j.id=r.job_id AND j.member_id=lc.user_id::uuid
   JOIN public.member_profiles p ON p.user_id=lc.user_id::uuid
   LEFT JOIN ada_history.member_links l ON l.member_id=p.user_id AND l.source_id='hq000/AdaAcc'
    AND l.ada_code=CASE WHEN left(p.member_code,4)='ADA-' THEN substring(p.member_code from 5) ELSE p.member_code END
   LEFT JOIN ada_history.customers a ON a.source_id=l.source_id AND a.ada_code=l.ada_code
   WHERE r.origin_branch=$1 AND r.state<>'review' AND r.next_check_at<=now() AND($2::text[] IS NULL OR r.claim_id=ANY($2))
    AND(r.state<>'running' OR r.lease_until<now()) ORDER BY r.next_check_at,r.claim_id FOR UPDATE OF r SKIP LOCKED LIMIT 1`,[body.originBranch,control.pilot_claims])).rows[0];
  if(!row){await c.query('COMMIT');return {ok:true,job:null};}
  if(!row.ada_code||!row.expected_name||!/^AR\d{3}-\d{6}$/.test(row.ada_code)||!['001','002'].includes(row.origin_pos)){
   await c.query(`UPDATE sccrm_receipt_sync.completeness SET state='retry',code='RECON_WAITING_MEMBER',next_check_at=now()+interval '15 seconds',
    lease_token=NULL,lease_until=NULL,updated_at=now() WHERE claim_id=$1`,[row.claim_id]);await c.query('COMMIT');return {ok:true,job:null};
  }
  const token=randomUUID(),baseline=hash(row.receipt_snapshot);
  await c.query(`UPDATE sccrm_receipt_sync.completeness SET state='running',lease_token=$2,baseline_hash=$3,
   lease_until=now()+interval '90 seconds',attempts=attempts+1,updated_at=now() WHERE claim_id=$1`,[row.claim_id,token,baseline]);
  await c.query('COMMIT');
  return {ok:true,job:{id:row.claim_id,leaseToken:token,baselineHash:baseline,policy:POLICY,
   identity:{branchCode:row.origin_branch,posCode:row.origin_pos,receiptNo:row.receipt_no,memberId:row.member_id,adaCode:row.ada_code},
   expectedName:row.expected_name,expectedPhone:row.expected_phone||null}};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function repairQueue(c,row,lc,snapshot,identity,p,proof){
 const ds=(await c.query(`SELECT * FROM sccrm_receipt_sync.native_deliveries WHERE parent_id=$1 ORDER BY revision,target_branch FOR UPDATE`,[row.job_id])).rows;
 if(!ds.length){
  await c.query(`UPDATE sccrm_receipt_sync.jobs SET state='pending',last_code='RECON_VERIFIED',next_attempt_at=now(),updated_at=now()
   WHERE id=$1 AND state='review' AND last_code='RECON_WAITING_INITIAL_AUDIT'`,[row.job_id]);return;
 }
 const current=Math.max(...ds.map(d=>d.revision)),latest=ds.filter(d=>d.revision===current);
 if(latest.length!==2||latest.some(d=>d.payload.memberId!==identity.memberId||d.payload.adaCode!==identity.adaCode||d.payload.receiptNo!==identity.receiptNo))throw Object.assign(Error('RECON_DELIVERY_IDENTITY_REVIEW'),{code:'RECON_DELIVERY_IDENTITY_REVIEW'});
 if(latest.some(d=>d.state==='succeeded'&&!(d.target_branch==='000'?p.hqOwned:p.sourceOwned)))throw Object.assign(Error('RECON_NATIVE_OWNER_INCONSISTENT'),{code:'RECON_NATIVE_OWNER_INCONSISTENT'});
 if(!p.changed&&!latest.some(d=>d.state==='review')&&latest.every(d=>equal(d.payload.items,snapshot.items)&&d.payload.totalAmount===snapshot.totalAmount))return;
 for(const d of latest){
  const id=randomUUID(),payload={...d.payload,operationId:id,items:snapshot.items,totalAmount:snapshot.totalAmount,lineAdjustments:snapshot.lineAdjustments||null},owned=d.target_branch==='000'?p.hqOwned:p.sourceOwned;
  const native=d.target_branch==='000'?proof.hq:proof.source;
  if(!owned&&native.journals.length)throw Object.assign(Error('RECON_NATIVE_OWNER_INCONSISTENT'),{code:'RECON_NATIVE_OWNER_INCONSISTENT'});
  const verified=owned?{operationId:id,payloadHash:hash(payload),adaCode:identity.adaCode,receiptNo:identity.receiptNo,branchCode:identity.branchCode,
   posCode:identity.posCode,targetBranch:d.target_branch,tables:[native.table],outcome:'already_linked',verifiedAt:new Date().toISOString(),verificationPolicy:POLICY}:null;
  await c.query(`INSERT INTO sccrm_receipt_sync.native_deliveries(id,parent_id,target_branch,payload,payload_hash,revision,state,last_code,proof)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,row.job_id,d.target_branch,payload,hash(payload),current+1,owned?'succeeded':'pending',owned?'ADA_RECEIPT_VERIFIED':'RECON_FILLED',verified]);
 }
 await c.query(`UPDATE sccrm_receipt_sync.jobs SET state='pending',last_code='RECON_FILLED',next_attempt_at=now(),lease_token=NULL,lease_until=NULL,completed_at=NULL,updated_at=now() WHERE id=$1`,[row.job_id]);
}
async function apply(c,row,lc,p,identity,proof){
 const old=lc.receipt_snapshot,items=(await c.query('SELECT * FROM public.loyalty_claim_items WHERE claim_id=$1 FOR UPDATE',[lc.id])).rows;
 const signature=i=>JSON.stringify([i.productCode,i.productName,Number(i.qty),Number(i.unitPrice),Number(i.lineTotal)]);
 const stored=items.map(i=>signature({productCode:i.product_code,productName:i.product_name,qty:i.qty,unitPrice:i.unit_price,lineTotal:i.line_total})).sort();
 if(!equal(stored,old.items.map(signature).sort()))throw Object.assign(Error('RECON_STORED_LINES_REVIEW'),{code:'RECON_STORED_LINES_REVIEW'});
 const mirrors=(await c.query('SELECT * FROM public.crm_pos_sale_events WHERE branch_code=$1 AND doc_no=$2 FOR UPDATE',[identity.branchCode,identity.receiptNo])).rows;
 if(mirrors.length!==1)throw Object.assign(Error('RECON_MIRROR_IDENTITY_REVIEW'),{code:'RECON_MIRROR_IDENTITY_REVIEW'});
 const mirror=mirrors[0],lines=(await c.query('SELECT * FROM public.crm_pos_sale_line_events WHERE sale_event_id=$1 ORDER BY line_no FOR UPDATE',[mirror.id])).rows;
 const {legacyZero,resequence,aligned}=mirrorPlan(mirror,lines,lc,p,identity);
 const mirrorChanged=legacyZero||resequence||lines.length!==p.snapshot.items.length||lines.some(l=>!l.unit_code||!l.unit_name||!l.barcode)
  ||Number(mirror.net_total)!==p.snapshot.totalAmount||!equal(mirror.raw_payload.receipt_snapshot,p.snapshot);
 if(!p.changed&&!mirrorChanged)return false;
 // Avoid immediate unique-key collisions while preserving every line ID.
 if(resequence)await c.query('UPDATE public.crm_pos_sale_line_events SET line_no=-line_no WHERE sale_event_id=$1',[mirror.id]);
 for(const i of p.snapshot.items){
  if(!old.items.some(o=>o.seq===i.seq))await c.query(`INSERT INTO public.loyalty_claim_items(id,claim_id,product_code,product_name,qty,unit_price,line_total)VALUES($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),lc.id,i.productCode,i.productName,i.qty,i.unitPrice,i.lineTotal]);
  const l=aligned.find(pair=>pair.item.seq===i.seq)?.line;
  if(l)await c.query(`UPDATE public.crm_pos_sale_line_events SET unit_code=COALESCE(NULLIF(btrim(unit_code),''),$2),unit_name=COALESCE(NULLIF(btrim(unit_name),''),$3),
   barcode=COALESCE(NULLIF(btrim(barcode),''),$4),raw_payload=raw_payload||$5::jsonb,line_no=$6,
   net_amount=CASE WHEN $7 THEN $8 ELSE net_amount END,discount_amount=CASE WHEN $7 THEN $9 ELSE discount_amount END
   WHERE id=$1`,[l.id,i.unitCode,i.unitName,i.barcode,i,i.seq,legacyZero,i.lineTotal,i.lineDiscount]);
  else await c.query(`INSERT INTO public.crm_pos_sale_line_events(id,sale_event_id,line_no,product_code,barcode,qty,unit_code,unit_name,net_amount,discount_amount,raw_payload)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[randomUUID(),mirror.id,i.seq,i.productCode,i.barcode,i.qty,i.unitCode,i.unitName,i.lineTotal,i.lineDiscount,i]);
 }
 await c.query(`INSERT INTO sccrm_receipt_sync.completeness_audit(claim_id,code,before_hash,after_hash,original_snapshot,final_snapshot,proof)
  VALUES($1,'RECON_FILLED',$2,$3,$4,$5,$6)`,[lc.id,hash(old),hash(p.snapshot),old,p.snapshot,{...proof,originalMirror:mirror,originalMirrorLines:lines,mirrorRepair:{legacyZero,resequence}}]);
 await c.query('UPDATE public.loyalty_claims SET receipt_snapshot=$2,receipt_total_amount=$3 WHERE id=$1',[lc.id,p.snapshot,p.snapshot.totalAmount]);
 await c.query(`UPDATE public.crm_pos_sale_events SET net_total=$2,paid_total=$2,gross_total=$2::numeric+$3::numeric,
  pos_code=CASE WHEN $5 THEN $6 ELSE pos_code END,sale_at=CASE WHEN $5 THEN $7::timestamptz ELSE sale_at END,
  ada_customer_code=CASE WHEN $5 THEN $8 ELSE ada_customer_code END,
  raw_payload=raw_payload||jsonb_build_object('receipt_snapshot',$4::jsonb)||CASE WHEN $5 THEN jsonb_build_object('loyalty_claim_id',$9::text) ELSE '{}'::jsonb END,
  updated_at=now() WHERE id=$1`,[mirror.id,p.snapshot.totalAmount,p.snapshot.receiptDiscount,p.snapshot,legacyZero,identity.posCode,p.soldAt,identity.adaCode,lc.id]);
 return true;
}
async function acknowledge(db,body){
 if(!body||Object.keys(body).some(k=>!['id','leaseToken','baselineHash','policy','source','hq','errorCode'].includes(k))||!uuid.test(body.id||'')||!uuid.test(body.leaseToken||'')||!/^[a-f0-9]{64}$/.test(body.baselineHash||'')||body.policy!==POLICY
  ||body.errorCode&&!transient.has(body.errorCode)||body.errorCode&&(body.source||body.hq))throw invalid();
 const c=await db.connect();try{
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='2s'");
  const row=(await c.query('SELECT * FROM sccrm_receipt_sync.completeness WHERE claim_id=$1 FOR UPDATE',[body.id])).rows[0];
  if(!row)throw invalid();const digest=hash(body);
  if(row.last_token===body.leaseToken){if(row.last_ack_hash!==digest)throw invalid();await c.query('COMMIT');return {ok:true,accepted:true,replayed:true};}
  if(row.state!=='running'||row.lease_token!==body.leaseToken||new Date(row.lease_until).getTime()<=Date.now()||row.baseline_hash!==body.baselineHash){await c.query('COMMIT');return {ok:true,accepted:false};}
  const lc=(await c.query('SELECT * FROM public.loyalty_claims WHERE id=$1 FOR UPDATE',[body.id])).rows[0];
  const job=(await c.query('SELECT * FROM sccrm_receipt_sync.jobs WHERE id=$1 FOR UPDATE',[row.job_id])).rows[0];
  const linked=(await c.query(`SELECT l.ada_code FROM public.member_profiles m JOIN ada_history.member_links l ON l.member_id=m.user_id AND l.source_id='hq000/AdaAcc'
   AND l.ada_code=CASE WHEN left(m.member_code,4)='ADA-' THEN substring(m.member_code from 5) ELSE m.member_code END WHERE m.user_id=$1::uuid FOR UPDATE OF m`,[lc.user_id])).rows[0];
  let code=body.errorCode,state=code?'retry':'verified',evidence={};
  await c.query('SAVEPOINT completeness_apply');
  try{
   if(hash(lc.receipt_snapshot)!==body.baselineHash)throw Object.assign(Error('RECON_BASELINE_CHANGED'),{code:'RECON_BASELINE_CHANGED'});
   if(!linked||lc.user_id!==job.member_id||lc.branch_code!==row.origin_branch)throw Object.assign(Error('RECON_MEMBER_MAPPING_CHANGED'),{code:'RECON_MEMBER_MAPPING_CHANGED'});
   if(!code){const identity={memberId:lc.user_id,adaCode:linked.ada_code,branchCode:lc.branch_code,posCode:job.origin_pos,receiptNo:lc.receipt_no};
    const p=plan(lc.receipt_snapshot,body.source,body.hq,identity);evidence={filled:p.filled,appended:p.appended,financialAdjusted:p.financialChanged,sourceHash:p.sourceHash,policy:POLICY};
    const changed=await apply(c,row,lc,p,identity,{source:body.source,hq:body.hq});
    await repairQueue(c,row,lc,p.snapshot,identity,p,{source:body.source,hq:body.hq});
    code=changed?'RECON_FILLED':'RECON_VERIFIED';
   }
   await c.query('RELEASE SAVEPOINT completeness_apply');
  }catch(error){await c.query('ROLLBACK TO SAVEPOINT completeness_apply');await c.query('RELEASE SAVEPOINT completeness_apply');
   code=/^RECON_[A-Z_]+$/.test(error.code||'')?error.code:'RECON_APPLY_RETRY';state=transient.has(code)||['RECON_BASELINE_CHANGED','RECON_APPLY_RETRY'].includes(code)?'retry':'review';}
  await c.query(`UPDATE sccrm_receipt_sync.completeness SET state=$2,code=$3,evidence=$4,lease_token=NULL,lease_until=NULL,
   last_token=$5,last_ack_hash=$6,verified_at=CASE WHEN $2='verified' THEN now() ELSE verified_at END,
   next_check_at=now()+CASE WHEN $2='verified' THEN interval '10 minutes' ELSE make_interval(secs=>least(300,5*greatest(1,attempts))) END,updated_at=now() WHERE claim_id=$1`,[body.id,state,code,evidence,body.leaseToken,digest]);
  if(row.code!==code||code==='RECON_FILLED')await c.query(`INSERT INTO sccrm_receipt_sync.events(job_id,state,code)VALUES($1,$2,$3)`,[row.job_id,state==='verified'?'succeeded':state,code]);
  await c.query('COMMIT');require('./sccrmHistoryFirst').notify();return {ok:true,accepted:true,state,code};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
module.exports={enqueue,lease,acknowledge};
