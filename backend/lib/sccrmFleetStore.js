'use strict';
const crypto=require('node:crypto');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const ACTIVE=['pending','downloading','waiting_for_idle','installing','restarting'];
function error(code,status=400){return Object.assign(Error(code),{code,status});}
function keys(body,allowed){if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k)))throw error('INVALID_REQUEST');}
function heartbeatInput(body){
 keys(body,['protocol','nodeId','hostname','version','binaryHash','readiness']);
 if(body.protocol!==1||typeof body.nodeId!=='string'||body.nodeId.length>80||typeof body.hostname!=='string'||body.hostname.length>128
  ||typeof body.version!=='string'||!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(body.version)||!HASH.test(body.binaryHash||'')
  ||!['idle','busy','waiting_for_user'].includes(body.readiness))throw error('INVALID_HEARTBEAT');
 return body;
}
async function transaction(pool,operation){const db=await pool.connect();try{await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='8s'");const r=await operation(db);await db.query('COMMIT');return r;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
async function heartbeat(pool,staff,body){
 const value=heartbeatInput(body);
 return transaction(pool,async db=>{
  const node=(await db.query('SELECT * FROM sccrm_fleet.nodes WHERE node_id=$1',[value.nodeId])).rows[0];
  if(!node||node.hostname.toLowerCase()!==value.hostname.toLowerCase())throw error('UNAPPROVED_NODE',403);
  const prior=(await db.query('SELECT * FROM sccrm_fleet.devices WHERE staff_device_id=$1 OR node_id=$2 FOR UPDATE',[staff.id,value.nodeId])).rows;
  if(prior.some(row=>row.staff_device_id!==staff.id||row.node_id!==value.nodeId))throw error('ENROLLMENT_REQUIRES_REVIEW',409);
  await db.query(`INSERT INTO sccrm_fleet.devices(staff_device_id,node_id,protocol,version,binary_hash,readiness)
   VALUES($1,$2,1,$3,$4,$5) ON CONFLICT(staff_device_id) DO UPDATE SET version=EXCLUDED.version,
   binary_hash=EXCLUDED.binary_hash,readiness=EXCLUDED.readiness,last_seen_at=now()`,[staff.id,value.nodeId,value.version,value.binaryHash,value.readiness]);
  const enabled=(await db.query('SELECT enabled FROM sccrm_fleet.settings WHERE id=1')).rows[0]?.enabled===true;
  await db.query(`UPDATE sccrm_fleet.jobs SET state='expired',updated_at=now(),completed_at=now()
    WHERE staff_device_id=$1 AND expires_at<=now() AND state IN('pending','downloading','waiting_for_idle')`,[staff.id]);
  const job=enabled?(await db.query(`SELECT id,node_id,release_version,release_hash,release_envelope,state
    FROM sccrm_fleet.jobs WHERE staff_device_id=$1 AND state=ANY($2::text[]) ORDER BY created_at LIMIT 1`,[staff.id,ACTIVE])).rows[0]:null;
  return {ok:true,enabled,deviceId:staff.device_id,branchCode:node.branch_code,posCode:node.pos_code,command:job?{
   id:job.id,nodeId:job.node_id,version:job.release_version,sha256:job.release_hash,envelope:job.release_envelope,state:job.state}:null};
 });
}
async function report(pool,staff,body){
 keys(body,['jobId','state','code','installedHash']);
 if(!UUID.test(body.jobId||'')||!['downloading','waiting_for_idle','installing','restarting','succeeded','failed'].includes(body.state)
  ||(body.code!=null&&!/^[A-Z0-9_]{1,80}$/.test(body.code))||(body.installedHash!=null&&!HASH.test(body.installedHash)))throw error('INVALID_REPORT');
 return transaction(pool,async db=>{
  const job=(await db.query('SELECT * FROM sccrm_fleet.jobs WHERE id=$1 AND staff_device_id=$2 FOR UPDATE',[body.jobId,staff.id])).rows[0];
  if(!job)throw error('COMMAND_NOT_FOUND',404);
  if(job.state==='succeeded'&&body.state==='succeeded'&&body.installedHash===job.release_hash)return {ok:true,replayed:true};
  if(!ACTIVE.includes(job.state))throw error('COMMAND_ALREADY_TERMINAL',409);
  if(body.state==='installing'&&(await db.query('SELECT enabled FROM sccrm_fleet.settings WHERE id=1')).rows[0]?.enabled!==true)throw error('FLEET_CONTROL_PAUSED',409);
  if(body.state==='succeeded'&&body.installedHash!==job.release_hash)throw error('INSTALLED_HASH_MISMATCH',409);
  const flow={pending:['downloading','waiting_for_idle','installing','succeeded','failed'],downloading:['downloading','waiting_for_idle','installing','failed'],
   waiting_for_idle:['waiting_for_idle','downloading','installing','succeeded','failed'],installing:['installing','waiting_for_idle','restarting','succeeded','failed'],restarting:['restarting','succeeded','failed']};
  if(!flow[job.state].includes(body.state))throw error('INVALID_COMMAND_TRANSITION',409);
  if(job.state!==body.state||job.result_code!==(body.code||null)){
   await db.query(`UPDATE sccrm_fleet.jobs SET state=$2,result_code=$3,updated_at=now(),
     completed_at=CASE WHEN $2 IN('succeeded','failed') THEN now() ELSE NULL END WHERE id=$1`,[job.id,body.state,body.code||null]);
   await db.query('INSERT INTO sccrm_fleet.events(job_id,state,code) VALUES($1,$2,$3)',[job.id,body.state,body.code||null]);
  }
  return {ok:true};
 });
}
async function inventory(pool){
 const devices=(await pool.query(`SELECT n.node_id AS "nodeId",n.branch_code AS "branchCode",n.pos_code AS "posCode",n.hostname,
  d.version,d.binary_hash AS "binaryHash",d.readiness,d.last_seen_at AS "lastSeenAt",d.protocol,
  (sd.revoked_at IS NULL AND d.staff_device_id IS NOT NULL) AS enrolled,(d.last_seen_at>now()-interval '90 seconds') AS online,
  j.id AS "jobId",j.state AS "jobState",j.release_version AS "targetVersion",j.result_code AS "resultCode",j.updated_at AS "jobUpdatedAt"
  FROM sccrm_fleet.nodes n LEFT JOIN sccrm_fleet.devices d ON d.node_id=n.node_id
  LEFT JOIN public.staff_devices sd ON sd.id=d.staff_device_id
  LEFT JOIN LATERAL(SELECT * FROM sccrm_fleet.jobs WHERE staff_device_id=d.staff_device_id ORDER BY created_at DESC LIMIT 1)j ON true
  ORDER BY n.branch_code,n.pos_code`)).rows;
 const enabled=(await pool.query('SELECT enabled FROM sccrm_fleet.settings WHERE id=1')).rows[0]?.enabled===true;
 return {ok:true,enabled,devices};
}
async function issue(pool,admin,body,getRelease){
 keys(body,['requestId','nodeIds','expectedReleaseHash']);
 if(!UUID.test(body.requestId||'')||!Array.isArray(body.nodeIds)||!body.nodeIds.length||body.nodeIds.length>32
  ||body.nodeIds.some(n=>typeof n!=='string'||n.length>80)||new Set(body.nodeIds).size!==body.nodeIds.length||!HASH.test(body.expectedReleaseHash||''))throw error('INVALID_COMMAND');
 const targets=[...body.nodeIds].sort();
 const requestHash=crypto.createHash('sha256').update(JSON.stringify({targets,hash:body.expectedReleaseHash})).digest('hex');
 return transaction(pool,async db=>{
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['sccrm-fleet-issue']);
  const old=(await db.query('SELECT request_hash,result FROM sccrm_fleet.batches WHERE id=$1',[body.requestId])).rows[0];
  if(old){if(old.request_hash!==requestHash)throw error('REQUEST_ID_REUSED',409);return {...old.result,replayed:true};}
  if((await db.query('SELECT enabled FROM sccrm_fleet.settings WHERE id=1')).rows[0]?.enabled!==true)throw error('FLEET_CONTROL_PAUSED',409);
  const release=await getRelease();
  if(body.expectedReleaseHash!==release.sha256)throw error('RELEASE_CHANGED_REVIEW_AGAIN',409);
  const nodes=(await db.query(`SELECT n.node_id,d.staff_device_id,d.protocol,sd.revoked_at FROM sccrm_fleet.nodes n
    LEFT JOIN sccrm_fleet.devices d ON d.node_id=n.node_id LEFT JOIN public.staff_devices sd ON sd.id=d.staff_device_id
    WHERE n.node_id=ANY($1::text[]) ORDER BY n.node_id`,[targets])).rows;
  if(nodes.length!==targets.length)throw error('UNAPPROVED_TARGET',400);
  await db.query('INSERT INTO sccrm_fleet.batches(id,request_hash,created_by,release_version,release_hash,targets) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[body.requestId,requestHash,admin.id,release.version,release.sha256,JSON.stringify(targets)]);
  const jobs=[],notReady=[];
  for(const n of nodes){
   if(!n.staff_device_id||n.protocol!==1||n.revoked_at){notReady.push({nodeId:n.node_id,code:'NEEDS_BOOTSTRAP'});continue;}
   const running=(await db.query('SELECT id,state,release_hash FROM sccrm_fleet.jobs WHERE staff_device_id=$1 AND state=ANY($2::text[])',[n.staff_device_id,ACTIVE])).rows[0];
   if(running){notReady.push({nodeId:n.node_id,code:'COMMAND_IN_PROGRESS',jobId:running.id});continue;}
   const id=crypto.randomUUID();
   await db.query('INSERT INTO sccrm_fleet.jobs(id,batch_id,staff_device_id,node_id,release_version,release_hash,release_envelope) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,body.requestId,n.staff_device_id,n.node_id,release.version,release.sha256,release.envelope]);
   await db.query("INSERT INTO sccrm_fleet.events(job_id,state,code) VALUES($1,'pending','ADMIN_REQUEST')",[id]);
   jobs.push({id,nodeId:n.node_id,state:'pending'});
  }
  const result={ok:true,batchId:body.requestId,jobs,notReady};
  await db.query('UPDATE sccrm_fleet.batches SET result=$2::jsonb WHERE id=$1',[body.requestId,JSON.stringify(result)]);
  return result;
 });
}
module.exports={heartbeat,report,inventory,issue,error,heartbeatInput,ACTIVE};
