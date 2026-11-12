'use strict';
const {createHash}=require('node:crypto');
const {isDeepStrictEqual:equal}=require('node:util');
const {normalizeReceiptItems}=require('./receiptLines');
const POLICY='ada-receipt-completeness-v1';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
const text=v=>String(v??'').trim();
const num=v=>typeof v==='number'&&Number.isFinite(v);
const missing=v=>v==null||typeof v==='string'&&!v.trim();
const sameNumber=(a,b)=>num(a)&&num(b)&&Math.abs(a-b)<0.00001;
const lineFields=['seq','productCode','productName','barcode','unitCode','unitName','qty','unitPrice','lineTotal','lineDiscount','promotionCode'];
const fillable=new Set(['productName','barcode','unitCode','unitName']);
function canonical(observation,identity){
 if(!observation||observation.policy!==POLICY||observation.targetBranch!==identity.targetBranch||observation.stableReadCount!==2
  ||!observation.header||!Array.isArray(observation.items)||!Array.isArray(observation.payments)||!Array.isArray(observation.journals)
  ||observation.items.length>1000||observation.payments.length>100||observation.journals.length>1)fail('RECON_PACKET_REFUSED');
 const h=observation.header;
 if(!['TPSTSalHD','TSHD'+identity.posCode].includes(observation.table)||identity.targetBranch==='000'&&observation.table!=='TPSTSalHD')fail('RECON_PACKET_REFUSED');
 if(h.branchCode!==identity.branchCode||h.posCode!==identity.posCode||h.receiptNo!==identity.receiptNo
  ||h.docType!=='1'||h.paidStatus!=='3'||h.documentStatus!=='1')fail('RECON_SOURCE_NOT_FINAL');
 if(!num(h.totalAmount)||h.totalAmount<=0||!num(h.receiptDiscount)||h.receiptDiscount<0||!num(h.rounding)
  ||!observation.payments.length||observation.payments.some(p=>!num(p.net)||!num(p.amount)||!num(p.change)||!text(p.code))
  ||Math.abs(observation.payments.reduce((v,p)=>v+p.net,0)-h.totalAmount)>0.004)fail('RECON_PAYMENT_INCOMPLETE');
 if(observation.memberMatches!==true)fail('RECON_MEMBER_REQUIRES_REVIEW');
 const owner=text(h.adaCode);
 if(owner&&owner!==identity.adaCode&&!(owner==='0'&&observation.walkInVerified===true))fail('RECON_OTHER_OWNER');
 if(observation.journals.some(j=>j.adaCode!==identity.adaCode||j.branchCode!==identity.branchCode||j.posCode!==identity.posCode||j.receiptNo!==identity.receiptNo))fail('RECON_OTHER_OWNER');
 if(!observation.items.length||new Set(observation.items.map(i=>i.seq)).size!==observation.items.length
  ||observation.items.some(i=>!Number.isSafeInteger(i.seq)||i.seq<1||!text(i.productCode)||!text(i.productName)||!text(i.barcode)
   ||!text(i.unitCode)||!text(i.unitName)||!num(i.qty)||i.qty===0||!num(i.unitPrice)||i.unitPrice<0||!num(i.lineTotal)||!num(i.lineDiscount)))fail('RECON_SOURCE_FIELDS_INCOMPLETE');
 let normalized;try{normalized=normalizeReceiptItems(observation.items);}catch{fail('RECON_SOURCE_VOID_REVIEW');}
 const stamp=h.docDate+'T'+h.docTime+'+07:00';
 if(!/^\d{4}-\d{2}-\d{2}$/.test(h.docDate||'')||!/^\d{2}:\d{2}:\d{2}$/.test(h.docTime||'')||!Number.isFinite(Date.parse(stamp)))fail('RECON_SOURCE_TIME_INCOMPLETE');
 return {posCode:h.posCode,totalAmount:h.totalAmount,receiptDiscount:h.receiptDiscount,rounding:h.rounding,soldAt:new Date(stamp).toISOString(),
  items:normalized.items.map(i=>Object.fromEntries(lineFields.map(k=>[k,k==='lineDiscount'?(i[k]??0):k==='promotionCode'?(text(i[k])||null):i[k]]))),lineAdjustments:normalized.lineAdjustments};
}
function plan(old,source,hq,identity){
 const a=canonical(source,{...identity,targetBranch:identity.branchCode}),b=canonical(hq,{...identity,targetBranch:'000'});
 if(!equal(a,b))fail('RECON_SOURCE_HQ_DIFFERENT');
 if(!old||old.posCode!==identity.posCode||!Array.isArray(old.items)||!old.items.length||old.items.length>a.items.length)fail('RECON_SNAPSHOT_REQUIRES_REVIEW');
 const filled=[];
 for(let n=0;n<old.items.length;n++)for(const key of lineFields){
  const previous=old.items[n][key]??(key==='lineDiscount'?0:null),next=a.items[n][key];
  if(fillable.has(key)&&missing(previous)){filled.push({seq:a.items[n].seq,field:key});continue;}
  if(typeof next==='number'? !sameNumber(previous,next):text(previous)!==text(next))fail('RECON_EXISTING_LINE_CHANGED');
 }
 const appended=a.items.length-old.items.length;
 const financialChanged=!sameNumber(old.totalAmount,a.totalAmount)||old.receiptDiscount!=null&&!sameNumber(old.receiptDiscount,a.receiptDiscount);
 if(financialChanged&&(!num(old.receiptDiscount)||Math.abs(old.items.reduce((v,i)=>v+i.lineTotal,0)-old.receiptDiscount+(old.rounding||0)-old.totalAmount)>0.004
  ||Math.abs(a.items.reduce((v,i)=>v+i.lineTotal,0)-a.receiptDiscount+a.rounding-a.totalAmount)>0.004))fail('RECON_EXISTING_FINANCIALS_CHANGED');
 const snapshot={...old,items:a.items,totalAmount:a.totalAmount,receiptDiscount:a.receiptDiscount,totalAmountSource:'pos_header'};
 if(a.lineAdjustments)snapshot.lineAdjustments=a.lineAdjustments;
 else if(old.lineAdjustments)fail('RECON_VOID_AUDIT_CHANGED');
 return {snapshot,filled,appended,financialChanged,soldAt:a.soldAt,changed:!equal(old,snapshot),sourceHash:hash(a),sourceOwned:text(source.header.adaCode)===identity.adaCode,hqOwned:text(hq.header.adaCode)===identity.adaCode};
}
module.exports={POLICY,hash,canonical,plan};
