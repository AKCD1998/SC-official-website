'use strict';
const outbox=require('./sccrmHistoryFirst');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid(){return Object.assign(Error('ข้อมูลสมาชิกหรือรายการไม่ถูกต้อง'),{status:400});}
async function summaries(db,ids){
 if(!outbox.enabled()||!ids.length)return new Map();
 if(ids.length>100||ids.some(id=>!UUID.test(id)))throw invalid();
 const {rows}=await db.query(`WITH wanted AS(SELECT unnest($1::uuid[]) id)
  SELECT w.id,m.member_code,l.ada_code,a.ada_code AS assigned_code,a.deliver_to_branches,c.ada_code AS imported_code,
   o.state AS outbound_state,o.last_code AS outbound_code,
   q.id AS job_id,q.state AS job_state,q.last_code,q.updated_at,q.created_at,
   COALESCE(b.branches,'[]'::json) branches
  FROM wanted w LEFT JOIN public.member_profiles m ON m.user_id=w.id
  LEFT JOIN ada_history.member_links l ON l.member_id=w.id AND l.source_id='hq000/AdaAcc'
   AND l.ada_code=CASE WHEN left(m.member_code,4)='ADA-' THEN substring(m.member_code from 5) ELSE m.member_code END
  LEFT JOIN sccrm_member_codes.assignments a ON a.member_id=w.id
  LEFT JOIN ada_history.customers c ON c.directory_id=w.id AND m.user_id IS NULL AND c.source_id='hq000/AdaAcc'
  LEFT JOIN ada_history.outbound_state o ON o.member_id=w.id
  LEFT JOIN LATERAL(SELECT id,state,last_code,updated_at,created_at FROM sccrm_receipt_sync.jobs
   WHERE member_id=w.id AND kind='member' ORDER BY created_at DESC LIMIT 1)q ON true
  LEFT JOIN LATERAL(SELECT json_agg(json_build_object('branchCode',t.branch_code,
   'ready',COALESCE(j.state='succeeded' AND mp.member_id=w.id AND mp.ada_code=a.ada_code,false),
   'state',COALESCE(j.state,'pending'),'code',j.last_code,'completedAt',j.completed_at) ORDER BY t.branch_code) branches
   FROM sccrm_member_codes.targets t LEFT JOIN sccrm_member_codes.jobs j ON j.target_id=t.target_id AND j.assignment_id=a.assignment_id
   LEFT JOIN sccrm_member_codes.mappings mp ON mp.target_id=t.target_id AND mp.assignment_id=a.assignment_id
   WHERE a.deliver_to_branches=true)b ON true`,[ids]);
 return new Map(rows.map(r=>{
  let state='pending',code='WAITING_FOR_HQ',label='SCCRM บันทึกแล้ว รอส่งเข้า Ada HQ';
  if(r.assigned_code && r.ada_code && r.assigned_code!==r.ada_code){state='review';code='MEMBER_MAPPING_CONFLICT';label=outbox.label(code);}
  else if(r.imported_code){state='existing';code='ADA_EXISTING';label='สมาชิกเดิมจาก Ada';}
  else if(r.ada_code){
   if(r.deliver_to_branches!==true){state='succeeded';code='EXISTING_MEMBER_LINK_VERIFIED';label='ผูกกับสมาชิก Ada เดิมแล้ว';}
   else if(['001','003','004','005'].every(branch=>r.branches.filter(b=>b.branchCode===branch&&b.ready).length===1)){
    state='succeeded';code='MEMBER_ALL_BRANCHES_VERIFIED';label='ตรวจพบสมาชิกใน Ada ครบทุกสาขาแล้ว';
   }else{state=r.branches.some(b=>b.state==='review')?'review':'pending';code=state==='review'?'BRANCH_REQUIRES_REVIEW':'WAITING_FOR_BRANCHES';label=outbox.label(code);}
  }else if(r.outbound_state==='review'||r.job_state==='review'){state='review';code='MEMBER_REQUIRES_REVIEW';label=outbox.label(code);}
  return [r.id,{state,code,label,hqReady:Boolean(r.ada_code||r.imported_code),adaCode:r.ada_code||r.imported_code||null,
   branches:r.branches,jobId:r.job_id||null,updatedAt:r.updated_at||null,tracked:Boolean(r.job_id)}];
 }));
}
async function detail(db,id){
 if(!UUID.test(id))throw invalid();
 if(!await outbox.available(db))throw Object.assign(Error('ยังไม่เปิดระบบติดตามการส่งข้อมูล'),{status:503});
 const summary=(await summaries(db,[id])).get(id);
 const person=(await db.query('SELECT id,full_name,member_code FROM ada_history.directory WHERE id=$1::uuid',[id])).rows[0];
 if(!person)throw Object.assign(Error('ไม่พบสมาชิกนี้'),{status:404});
 const {rows:events}=await db.query(`SELECT * FROM(
  SELECT e.occurred_at AS at,e.code,e.state,COALESCE(e.target_branch,j.origin_branch) AS branch_code,j.kind,c.receipt_no
   FROM sccrm_receipt_sync.events e JOIN sccrm_receipt_sync.jobs j ON j.id=e.job_id
   LEFT JOIN public.loyalty_claims c ON c.id=j.claim_id WHERE j.member_id=$1
  UNION ALL SELECT r.registered_at,'SCCRM_REGISTRATION_STORED','succeeded',r.branch_code,'member',NULL
   FROM crm_reporting.member_registrations r WHERE r.member_id=$1
  UNION ALL SELECT a.assigned_at,'HQ_MEMBER_CREATED','succeeded','000','member',NULL
   FROM sccrm_member_codes.assignments a WHERE a.member_id=$1
  UNION ALL SELECT e.occurred_at,'BRANCH_'||upper(e.state),e.state,t.branch_code,'member',NULL
   FROM sccrm_member_codes.events e JOIN sccrm_member_codes.jobs j ON j.id=e.job_id
   JOIN sccrm_member_codes.targets t ON t.target_id=j.target_id WHERE j.member_id=$1
 )history ORDER BY at DESC,code LIMIT 150`,[id]);
 const receipts=(await db.query(`SELECT j.*,u.full_name,m.member_code,c.receipt_no FROM sccrm_receipt_sync.jobs j
   JOIN public.users u ON u.id=j.member_id JOIN public.member_profiles m ON m.user_id=u.id
   LEFT JOIN public.loyalty_claims c ON c.id=j.claim_id WHERE j.member_id=$1 ORDER BY j.created_at DESC LIMIT 100`,[id])).rows;
 return {ok:true,member:{id,name:person.full_name,memberCode:person.member_code},summary,jobs:receipts.map(r=>({
  id:r.id,kind:r.kind,receiptNo:r.receipt_no||null,branchCode:r.origin_branch,state:r.state,label:outbox.label(r.last_code||'SCCRM_STORED'),attempts:r.attempt_count,nextAttemptAt:r.next_attempt_at,
  deliveries:(r.evidence?.nativeReceipts||[]).map(d=>({...d,label:outbox.label(d.code||'WAITING_FOR_ADA_RECEIPT_DELIVERY')})),
 })),events:events.map(e=>({...e,label:e.code==='SCCRM_REGISTRATION_STORED'?'SCCRM บันทึกสมาชิกแล้ว':e.code==='HQ_MEMBER_CREATED'?'Ada HQ สร้างสมาชิกและออกเลข AR แล้ว':
  e.code==='BRANCH_SUCCEEDED'?'ส่งสมาชิกถึงสาขา '+e.branch_code+' แล้ว':e.code.startsWith('BRANCH_')?'การส่งสาขา '+e.branch_code+': '+({running:'กำลังส่ง',pending:'รอส่ง',retry:'รอลองใหม่',review:'ต้องตรวจสอบ'}[e.state]||e.state):outbox.label(e.code)}))};
}
async function retry(db,id,body){
 if(!UUID.test(id)||!body||Object.keys(body).some(k=>!['jobId','actor'].includes(k))||!UUID.test(body.jobId||'')||body.actor?.role!=='admin'||!body.actor.id)throw invalid();
 const row=(await db.query('SELECT origin_branch FROM sccrm_receipt_sync.jobs WHERE id=$1 AND member_id=$2',[body.jobId,id])).rows[0];
 if(!row)throw Object.assign(Error('ไม่พบรายการส่งของสมาชิกนี้'),{status:404});
 return outbox.retry(db,{branch_code:row.origin_branch},body.jobId);
}
module.exports={summaries,detail,retry};
