'use strict';
const {isDeepStrictEqual:equal}=require('node:util');
const fail=code=>{throw Object.assign(Error(code),{code});};
const empty=v=>v==null||typeof v==='string'&&!v.trim();

// Two historical producer shapes only. Native plan() has already verified
// the exact member, paid bill, tenders and independently stable branch/HQ data.
function mirrorPlan(mirror,lines,claim,p,identity){
 const raw=mirror.raw_payload||{},snapshot=p.snapshot;
 if(raw.member_id&&raw.member_id!==identity.memberId)fail('RECON_MIRROR_IDENTITY_REVIEW');
 const linked=raw.loyalty_claim_id===claim.id;
 const legacyZero=raw.loyalty_claim_id==null&&mirror.source_system==='AdaAcc'
  &&mirror.source_event_key===`sale:${identity.branchCode}:${identity.receiptNo}`
  &&mirror.branch_code===identity.branchCode&&mirror.doc_no===identity.receiptNo&&mirror.doc_type==='1'
  &&(empty(mirror.pos_code)||mirror.pos_code===identity.posCode)
  &&(empty(mirror.ada_customer_code)||mirror.ada_customer_code==='0'||mirror.ada_customer_code===identity.adaCode)
  &&Number(mirror.net_total)===0&&Number(mirror.paid_total)===0
  &&[0,snapshot.totalAmount+snapshot.receiptDiscount].includes(Number(mirror.gross_total))
  &&p.sourceOwned&&p.hqOwned&&lines.length===snapshot.items.length&&lines.length>0
  &&lines.every(l=>Number(l.net_amount)===0&&Number(l.discount_amount)===0);
 if(!linked&&!legacyZero)fail('RECON_MIRROR_IDENTITY_REVIEW');
 const resequence=linked&&snapshot.lineAdjustments?.policy==='ada-exact-item-void-pairs'
  &&snapshot.lineAdjustments.pairs?.length>0&&equal(raw.receipt_snapshot,claim.receipt_snapshot)
  &&lines.length===snapshot.items.length&&lines.some((l,n)=>l.line_no!==snapshot.items[n].seq)
  &&lines.every((l,n)=>l.line_no===n+1&&equal(l.raw_payload,snapshot.items[n]));
 const aligned=lines.map((line,n)=>({line,item:resequence?snapshot.items[n]:snapshot.items.find(i=>i.seq===line.line_no)}));
 if(aligned.some(({line:l,item:i})=>!i||l.product_code!==i.productCode||Number(l.qty)!==i.qty
  ||!legacyZero&&Number(l.net_amount)!==i.lineTotal
  ||!empty(l.barcode)&&l.barcode!==i.barcode||!empty(l.unit_code)&&l.unit_code!==i.unitCode||!empty(l.unit_name)&&l.unit_name!==i.unitName))fail('RECON_MIRROR_LINES_REVIEW');
 return {legacyZero,resequence,aligned};
}
module.exports={mirrorPlan};
