'use strict';
// Operator-only recovery, never mounted as a browser or worker endpoint.
// This narrowly repairs missing suffix lines of a cashier-confirmed receipt.
const {createHash}=require('node:crypto');
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const equal=require('node:util').isDeepStrictEqual;
const fields=['seq','productCode','productName','barcode','unitCode','unitName','qty','unitPrice','lineTotal','lineDiscount','promotionCode'];
const line=i=>fields.map(k=>i[k]??(['lineDiscount'].includes(k)?0:null));
const refuse=code=>{throw Error('RECEIPT_RECOVERY_'+code);};
function validate(p){
 if(!p||p.policy!=='ada-final-missing-suffix-v1'||!p.claimId||!p.memberId||!/^AR[0-9]{3}-[0-9]{6}$/.test(p.adaCode||'')
  ||!['001','003','004','005'].includes(p.branchCode)||!['001','002'].includes(p.posCode)
  ||!/^S[0-9]{10}-[0-9]+$/.test(p.receiptNo||''))refuse('IDENTITY');
 const old=p.originalSnapshot,final=p.finalSnapshot,proof=p.nativeProof;
 if(!old||!final||old.posCode!==p.posCode||final.posCode!==p.posCode||old.lineAdjustments||final.lineAdjustments
  ||!Array.isArray(old.items)||!Array.isArray(final.items)||!old.items.length||old.items.length>=final.items.length
  ||final.items.length>1000||!old.items.every((v,i)=>equal(line(v),line(final.items[i]))))refuse('NOT_EXACT_PREFIX');
 if(final.items.some((i,n)=>i.seq!==n+1||!i.productCode||!i.unitCode||!i.unitName||!Number.isFinite(i.qty)||i.qty<=0
  ||!Number.isFinite(i.unitPrice)||i.unitPrice<0||!Number.isFinite(i.lineTotal)||i.lineTotal<0))refuse('LINE');
 if(!Number.isFinite(final.totalAmount)||final.totalAmount<=0||!Number.isFinite(final.receiptDiscount)||final.receiptDiscount<0
  ||!proof||proof.originBranch!==p.branchCode||proof.doc!==p.receiptNo||proof.pos!==p.posCode
  ||proof.paid!=='3'||proof.documentStatus!=='1'||proof.sourceAndHqMatch!==true||proof.stableReadCount<2
  ||proof.nativeJournalCount!==0||!proof.paymentRows||Math.abs(proof.paymentNet-final.totalAmount)>0.004
  ||Math.abs(final.items.reduce((v,i)=>v+i.lineTotal,0)-final.receiptDiscount+(proof.rounding||0)-final.totalAmount)>0.004
  ||proof.snapshotHash!==hash(final))refuse('FINAL_PROOF');
 return true;
}
async function recover(db,p){
 validate(p);const c=await db.connect();
 try{
  const prior=(await c.query('SELECT revision,packet_hash FROM sccrm_receipt_sync.final_revisions WHERE claim_id=$1 ORDER BY revision DESC LIMIT 1',[p.claimId])).rows[0];
  if(prior){if(prior.packet_hash!==hash(p))refuse('DIFFERENT_REPLAY');return {replayed:true,claimId:p.claimId,revision:prior.revision};}
  await c.query('BEGIN');await c.query("SET LOCAL TIME ZONE 'UTC'");
  const b=(await c.query(`SELECT jsonb_build_object('claim',to_jsonb(lc),'job',to_jsonb(j),
   'items',(SELECT jsonb_agg(i ORDER BY i.created_at,i.id) FROM loyalty_claim_items i WHERE i.claim_id=lc.id),
   'deliveries',(SELECT jsonb_agg(d ORDER BY d.target_branch) FROM sccrm_receipt_sync.native_deliveries d WHERE d.parent_id=j.id),
   'mirrors',(SELECT jsonb_agg(jsonb_build_object('header',to_jsonb(e),'items',(SELECT jsonb_agg(l ORDER BY l.line_no) FROM crm_pos_sale_line_events l WHERE l.sale_event_id=e.id)))
     FROM crm_pos_sale_events e WHERE e.branch_code=lc.branch_code AND e.doc_no=lc.receipt_no)) data
   FROM loyalty_claims lc JOIN sccrm_receipt_sync.jobs j ON j.claim_id=lc.id WHERE lc.id=$1`,[p.claimId])).rows[0]?.data;
  await c.query('COMMIT');
  if(!b||b.claim.user_id!==p.memberId||b.job.member_id!==p.memberId)refuse('OWNER');
  if(!equal(b.claim.receipt_snapshot,p.originalSnapshot))refuse('STALE');
  await c.query(require('./sccrmReceiptRecoverySql').build(b,p));
  return {replayed:false,claimId:p.claimId,revision:2,appendedLines:p.finalSnapshot.items.length-p.originalSnapshot.items.length};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
module.exports={validate,recover,hash};
