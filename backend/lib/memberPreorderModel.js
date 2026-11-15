'use strict';
const {createHash}=require('crypto');
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function fail(status,message,code){throw Object.assign(Error(message),{status,code})}
function id(value){if(typeof value!=='string'||!UUID.test(value))fail(400,'รหัสรายการไม่ถูกต้อง','INVALID_ID');return value.toLowerCase()}
function text(value,max,required=false){if(value==null)value='';if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))fail(400,'ข้อความยาวเกินไปหรือมีตัวอักษรที่ใช้ไม่ได้','INVALID_TEXT');value=value.trim();if(required&&!value)fail(400,'กรุณาระบุรายการสินค้า','REQUIRED_TEXT');return value}
function canonical(x){if(Array.isArray(x))return x.map(canonical);if(x&&typeof x==='object')return Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])]));return x}
function hash(x){return createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex')}
function draft(body){
 if(!body||typeof body!=='object'||!Array.isArray(body.items)||!body.items.length||body.items.length>40)fail(400,'เพิ่มสินค้าอย่างน้อย 1 รายการ และไม่เกิน 40 รายการ','INVALID_ITEMS');
 const date=body.occurredOn||null;
 if(date&&(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||date<'1753-01-01'||date>'9998-12-31'||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date))fail(400,'วันที่ไม่ถูกต้อง','INVALID_DATE');
 const months=body.frequencyMonths==null||body.frequencyMonths===''?null:Number(body.frequencyMonths);
 if(months!==null&&(!Number.isInteger(months)||months<1||months>120))fail(400,'รอบซื้อต้องเป็นจำนวนเดือน 1–120','INVALID_FREQUENCY');
 return {occurredOn:date,frequencyMonths:months,notes:text(body.notes,4000),sourceReference:text(body.sourceReference,255)||'พนักงานบันทึก',items:body.items.map(raw=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))fail(400,'รายการสินค้าไม่ถูกต้อง','INVALID_ITEM');
  const codes=[...new Set((Array.isArray(raw.productCodes)?raw.productCodes:raw.productCode?[raw.productCode]:[]).map(c=>text(c,64,true)))];
  if(codes.length>5||codes.some(c=>!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(c)))fail(400,'รหัสสินค้าไม่ถูกต้อง','INVALID_PRODUCT_CODE');
  const quantity=raw.quantity==null||raw.quantity===''?null:Number(raw.quantity);
  if(quantity!==null&&(!Number.isFinite(quantity)||quantity<=0||quantity>1000000))fail(400,'จำนวนสินค้าต้องมากกว่า 0 หรือเว้นว่างถ้าไม่ทราบ','INVALID_QUANTITY');
  return {productCodes:codes,productName:text(raw.productName,300,true),quantity,unit:text(raw.unit,60),sourceDescription:text(raw.sourceDescription,2000)};
 })};
}
function receiptRef(body){const branchCode=text(body.branchCode,3,true),receiptNo=text(body.receiptNo,100,true).toUpperCase();if(!/^\d{3}$/.test(branchCode)||!/^[A-Z0-9][A-Z0-9._/-]{0,99}$/.test(receiptNo))fail(400,'เลขบิลหรือสาขาไม่ถูกต้อง','INVALID_RECEIPT');return {branchCode,receiptNo}}
function netItems(items){
 const map=new Map();
 for(const i of items||[]){if(!i||typeof i.productCode!=='string')continue;const qty=Number(i.qty),net=Number(i.lineTotal);if(!Number.isFinite(qty)||!Number.isFinite(net))continue;
  const key=JSON.stringify([i.productCode,i.unitCode||'']);if(!map.has(key))map.set(key,{productCode:i.productCode,productName:i.productName||i.productCode,unitCode:i.unitCode||null,unitName:i.unitName||null,qty:0,lineTotal:0});
  const g=map.get(key);g.qty+=qty;g.lineTotal+=net;
 }
 return [...map.values()].filter(i=>i.qty>0).map(i=>({...i,qty:Math.round(i.qty*10000)/10000,lineTotal:Math.round(i.lineTotal*100)/100}));
}
function receiptSnapshot(memberId,p){
 const ref=receiptRef(p),items=netItems(p.items),total=Number(p.totalAmount),soldAt=new Date(p.soldAt).toISOString();
 if(!Number.isFinite(total)||total<0||!items.length)fail(409,'ข้อมูลบิลยังไม่ครบ กรุณาโหลดใหม่','INCOMPLETE_RECEIPT');
 return {memberId,...ref,posCode:p.posCode||null,soldAt,totalAmount:total,items,returns:(p.returns||[]).map(r=>({refundDocNo:r.refundDocNo,refundedAt:r.refundedAt,refundTotal:Number(r.refundTotal)||0,returnedQty:Number(r.returnedQty)||0}))};
}
function receiptCopies(memberId,purchases){
 const map=new Map();
 for(const p of purchases||[]){
  if(p.documentType&&String(p.documentType)!=='1')continue;
  let snap;try{snap=receiptSnapshot(memberId,p)}catch{continue}
  const key=snap.branchCode+'|'+snap.receiptNo,fingerprint=hash(snap),old=map.get(key);
  // Differing copies are held, never silently called the same preorder bill.
  if(old&&old.fingerprint!==fingerprint){old.needsReview=true;continue}
  if(!old)map.set(key,{...snap,fingerprint,needsReview:false});
 }
 return [...map.values()];
}
function candidates(memberId,records,purchases){
 const byCode=new Map();for(const r of records)for(const item of r.payload.items)for(const c of item.productCodes||[]){if(!byCode.has(c))byCode.set(c,[]);byCode.get(c).push(r.id)}
 return receiptCopies(memberId,purchases).map(snap=>({...snap,matchedItems:snap.items.filter(i=>byCode.has(i.productCode)).map(i=>({...i,historyIds:[...new Set(byCode.get(i.productCode))]}))})).filter(snap=>snap.matchedItems.length);
}
module.exports={UUID,id,text,hash,draft,receiptRef,netItems,receiptSnapshot,receiptCopies,candidates,fail};
