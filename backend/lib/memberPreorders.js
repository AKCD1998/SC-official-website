'use strict';
const {randomUUID}=require('crypto');
const model=require('./memberPreorderModel');
const {createCatalog}=require('./memberPreorderCatalog');
const MARKER='96718ac4-8e3c-4d5c-851d-1f4bd6c26015';
function createMemberPreorders(deps={}){
 const db=deps.db||require('../db'),catalog=deps.catalog||createCatalog(),history=deps.history||((id,q,c)=>require('./memberPurchaseHistory').getMemberPurchaseHistory(id,q,c,{includePoints:false}));
 async function ready(c=db){try{const r=(await c.query('SELECT marker,version,enabled FROM sccrm_preorders.meta WHERE singleton')).rows[0];if(r?.marker!==MARKER||r.version!==1||!r.enabled)throw Error()}catch{model.fail(503,'ระบบพรีออเดอร์ยังไม่พร้อมที่ส่วนกลาง ประวัติการซื้อเดิมยังใช้ได้','PREORDER_UNAVAILABLE')}}
 async function member(c,memberId,write=false){
  let r=(await c.query('SELECT u.id,u.full_name AS name,m.member_code AS code,m.is_active FROM public.users u JOIN public.member_profiles m ON m.user_id=u.id WHERE u.id=$1',[memberId])).rows[0];
  if(!r){const ada=deps.ada||require('./adaMemberMirror');const legacy=await ada.legacyProfile(c,memberId);if(legacy){if(write){await ada.ensureLegacyMember(c,memberId);return member(c,memberId,true)}r={id:memberId,name:legacy.full_name,code:legacy.member_code,is_active:legacy.is_active}}}
  if(!r)model.fail(404,'ไม่พบสมาชิกนี้','MEMBER_NOT_FOUND');if(write&&!r.is_active)model.fail(409,'สมาชิกนี้ถูกพักไว้ กรุณาเลือกสมาชิกที่ใช้งานอยู่','MEMBER_INACTIVE');return r;
 }
 async function records(c,memberId){return (await c.query('SELECT id,member_id,version,source_kind,source_reference,source_row,payload,created_by_device,updated_by_device,created_at,updated_at FROM sccrm_preorders.histories WHERE member_id=$1 ORDER BY created_at DESC,id DESC',[memberId])).rows}
 function recordView(r){return {id:r.id,version:r.version,sourceKind:r.source_kind,sourceReference:r.source_reference,sourceRow:r.source_row,createdAt:r.created_at,updatedAt:r.updated_at,...r.payload}}
 function billView(r,current){const snap=r.receipt_snapshot;return {id:r.id,confirmedAt:r.confirmed_at,...snap,matchedItems:r.matched_items,fingerprint:r.receipt_fingerprint,verificationStatus:current?(current.fingerprint===r.receipt_fingerprint&&!current.needsReview?'current':'changed'):'not_on_page',needsReview:!!current&&(current.fingerprint!==r.receipt_fingerprint||current.needsReview)}}
 async function list(rawId,query={}){
  const memberId=model.id(rawId);await ready();const m=await member(db,memberId),rs=await records(db,memberId);
  const links=(await db.query('SELECT * FROM sccrm_preorders.bill_links WHERE member_id=$1 AND revoked_at IS NULL ORDER BY confirmed_at DESC,id DESC',[memberId])).rows;
  const cursor=query.cursor?model.text(query.cursor,2048):null;let page,receiptMessage='';
  try{page=await history(memberId,{limit:100,cursor},db)}catch(e){if(e.status===400)throw e;receiptMessage='โหลดบิลจริงไม่ได้ตอนนี้ ข้อมูลที่จดไว้ยังดูและบันทึกได้';page={purchases:[],hasMore:false,nextCursor:null}}
  const proposed=model.candidates(memberId,rs,page.purchases),byKey=new Map(model.receiptCopies(memberId,page.purchases).map(p=>[p.branchCode+'|'+p.receiptNo,p]));
  const linked=new Set(links.map(l=>l.branch_code+'|'+l.receipt_no));
  return {ok:true,memberId,memberName:m.name,memberCode:m.code,records:rs.map(recordView),confirmedBills:links.map(l=>billView(l,byKey.get(l.branch_code+'|'+l.receipt_no))),candidates:proposed.filter(p=>!linked.has(p.branchCode+'|'+p.receiptNo)),receiptsAvailable:!receiptMessage,receiptMessage,hasMoreBills:!!page.hasMore,nextCursor:page.nextCursor||null};
 }
 async function request(rawMember,rawRequest,actor,action,input,work,prepare=null){
  const memberId=model.id(rawMember),requestId=model.id(rawRequest),actorId=model.text(actor?.device_id,160,true),bodyHash=model.hash({action,input});await ready();
  function replay(old){if(old.member_id!==memberId||old.actor_device!==actorId||old.body_hash!==bodyHash||old.action!==action)model.fail(409,'คำขอนี้มีข้อมูลเปลี่ยนแล้ว กรุณาโหลดรายการก่อนลองใหม่','REQUEST_CHANGED');return old.response}
  if(prepare){const old=(await db.query('SELECT * FROM sccrm_preorders.requests WHERE request_id=$1',[requestId])).rows[0];if(old)return replay(old);await prepare()}
  const c=await db.connect();try{
   await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='12s'");
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['member-preorders:'+memberId]);
   const m=await member(c,memberId,true);
   const old=(await c.query('SELECT * FROM sccrm_preorders.requests WHERE request_id=$1',[requestId])).rows[0];
   if(old){const response=replay(old);await c.query('COMMIT');return response}
   const result=await work(c,memberId,actorId,m);
   await c.query('INSERT INTO sccrm_preorders.requests(request_id,member_id,actor_device,action,body_hash,response)VALUES($1,$2,$3,$4,$5,$6::jsonb)',[requestId,memberId,actorId,action,bodyHash,JSON.stringify(result)]);
   await c.query('COMMIT');return result;
  }catch(e){await c.query('ROLLBACK');if(e.code==='23505')model.fail(409,'รายการนี้ถูกบันทึกแล้ว กรุณาโหลดข้อมูลใหม่','ALREADY_RECORDED');throw e}finally{c.release()}
 }
 async function event(c,memberId,actor,action,details){await c.query('INSERT INTO sccrm_preorders.events(member_id,actor_device,action,details)VALUES($1,$2,$3,$4::jsonb)',[memberId,actor,action,JSON.stringify(details)])}
 async function save(rawMember,body,actor,importSource=null){
  const value=model.draft(body),historyId=body.id?model.id(body.id):null,version=historyId?Number(body.version):0;
  if(historyId&&(!Number.isInteger(version)||version<1))model.fail(400,'รุ่นข้อมูลไม่ถูกต้อง กรุณาโหลดใหม่','INVALID_VERSION');
  if(importSource&&(importSource.kind!=='paper_import'||!Number.isInteger(importSource.row)||importSource.row<1||importSource.row>99999||!/^sha256:[a-f0-9]{64}$/.test(importSource.reference)))model.fail(400,'ที่มาของเอกสารไม่ถูกต้อง','INVALID_IMPORT_SOURCE');
  return request(rawMember,body.requestId,actor,historyId?'history_update':'history_create',{historyId,version,value,importSource},async(c,memberId,actorId)=>{
   let row;
   if(historyId){
    const old=(await c.query('SELECT * FROM sccrm_preorders.histories WHERE id=$1 AND member_id=$2 FOR UPDATE',[historyId,memberId])).rows[0];
    if(!old)model.fail(404,'ไม่พบรายการนี้ของสมาชิกที่เลือก','HISTORY_NOT_FOUND');if(old.version!==version)model.fail(409,'มีคนแก้ไขรายการนี้แล้ว กรุณาโหลดข้อมูลใหม่','VERSION_CONFLICT');
    const sourceReference=old.source_kind==='paper_import'?old.source_reference:value.sourceReference;
    if(old.source_kind==='paper_import')value.sourceReference=old.payload.sourceReference;
    row=(await c.query('UPDATE sccrm_preorders.histories SET version=version+1,payload=$3::jsonb,source_reference=$4,updated_by_device=$5,updated_at=now() WHERE id=$1 AND member_id=$2 RETURNING *',[historyId,memberId,JSON.stringify(value),sourceReference,actorId])).rows[0];
   }else{
    if(importSource){const old=(await c.query("SELECT * FROM sccrm_preorders.histories WHERE member_id=$1 AND source_kind='paper_import' AND source_reference=$2 AND source_row=$3",[memberId,importSource.reference,importSource.row])).rows[0];if(old)return {ok:true,memberId,record:recordView(old),replayed:true}}
    row=(await c.query('INSERT INTO sccrm_preorders.histories(id,member_id,version,source_kind,source_reference,source_row,payload,created_by_device,updated_by_device)VALUES($1,$2,1,$3,$4,$5,$6::jsonb,$7,$7)RETURNING *',[randomUUID(),memberId,importSource?'paper_import':'staff_note',importSource?.reference||value.sourceReference,importSource?.row||null,JSON.stringify(value),actorId])).rows[0];
   }
   await c.query('INSERT INTO sccrm_preorders.history_versions(history_id,version,payload,recorded_by_device)VALUES($1,$2,$3::jsonb,$4)',[row.id,row.version,JSON.stringify(value),actorId]);
   await event(c,memberId,actorId,historyId?'HISTORY_UPDATED':'HISTORY_CREATED',{id:row.id,version:row.version,sourceKind:row.source_kind,sourceReference:row.source_reference});
   return {ok:true,memberId,record:recordView(row)};
  },async()=>{value.items=await catalog.validate(value.items)});
 }
 async function confirm(rawMember,body,actor){
  const ref=model.receiptRef(body),fingerprint=model.text(body.fingerprint,64,true),cursor=body.sourceCursor?model.text(body.sourceCursor,2048):null;
  if(!/^[a-f0-9]{64}$/.test(fingerprint))model.fail(400,'ข้อมูลบิลไม่ถูกต้อง กรุณาโหลดบิลใหม่','INVALID_FINGERPRINT');
  return request(rawMember,body.requestId,actor,'bill_confirm',{...ref,fingerprint,cursor},async(c,memberId,actorId)=>{
   const page=await history(memberId,{limit:100,cursor},c),rs=await records(c,memberId);
   const candidate=model.candidates(memberId,rs,page.purchases).find(p=>p.branchCode===ref.branchCode&&p.receiptNo===ref.receiptNo);
   if(!candidate||candidate.needsReview||candidate.fingerprint!==fingerprint)model.fail(409,'ข้อมูลบิลหรือรายการสินค้าเปลี่ยนแล้ว กรุณาโหลดใหม่ก่อนยืนยัน','RECEIPT_CHANGED');
   const old=(await c.query('SELECT * FROM sccrm_preorders.bill_links WHERE branch_code=$1 AND receipt_no=$2 AND revoked_at IS NULL FOR UPDATE',[ref.branchCode,ref.receiptNo])).rows[0];
   if(old){if(old.member_id!==memberId)model.fail(409,'บิลนี้ถูกยืนยันให้สมาชิกอื่น กรุณาให้ผู้ดูแลตรวจสอบ','BILL_OTHER_MEMBER');if(old.receipt_fingerprint!==fingerprint)model.fail(409,'บิลนี้มีการเปลี่ยนข้อมูล กรุณาตรวจสอบรายการเดิมก่อน','RECEIPT_CHANGED');return {ok:true,memberId,bill:billView(old,candidate),replayed:true}}
   const {matchedItems,needsReview,fingerprint:ignored,...snapshot}=candidate;
   const row=(await c.query('INSERT INTO sccrm_preorders.bill_links(id,member_id,branch_code,receipt_no,receipt_fingerprint,receipt_snapshot,matched_items,confirmed_by_device)VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)RETURNING *',[randomUUID(),memberId,ref.branchCode,ref.receiptNo,fingerprint,JSON.stringify(snapshot),JSON.stringify(matchedItems),actorId])).rows[0];
   await event(c,memberId,actorId,'BILL_CONFIRMED',{id:row.id,...ref,fingerprint});return {ok:true,memberId,bill:billView(row,candidate)};
  });
 }
 async function revoke(rawMember,linkId,body,actor){
  const link=model.id(linkId),reason=model.text(body.reason,1000,true);
  return request(rawMember,body.requestId,actor,'bill_revoke',{link,reason},async(c,memberId,actorId)=>{
   const row=(await c.query('UPDATE sccrm_preorders.bill_links SET revoked_at=coalesce(revoked_at,now()),revoked_by_device=coalesce(revoked_by_device,$3),revoke_reason=coalesce(revoke_reason,$4) WHERE id=$1 AND member_id=$2 RETURNING id',[link,memberId,actorId,reason])).rows[0];
   if(!row)model.fail(404,'ไม่พบรายการยืนยันบิลของสมาชิกนี้','BILL_LINK_NOT_FOUND');await event(c,memberId,actorId,'BILL_CONFIRMATION_REVOKED',{id:link,reason});return {ok:true,memberId,id:link};
  });
 }
 return {list,save,confirm,revoke,catalog,ready};
}
module.exports={createMemberPreorders,MARKER};
