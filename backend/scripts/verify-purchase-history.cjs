'use strict';
// Opt-in component + real PostgreSQL/API integration. Live mode owns only its
// nonce-scoped synthetic members, staff device, and receipts; no AdaAcc access.
const fs=require('node:fs'),path=require('node:path');
const {randomUUID,randomInt,createHash}=require('node:crypto');
const {spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const {Client}=require('pg');
const args=process.argv.slice(2),live=args[0]==='--live';
if(!['--live','--local'].includes(args[0]) || args.length!==(live?5:3))throw Error('EXPLICIT_MODE_AND_PATHS_REQUIRED');
const [envFile,caFile,helper,output]=live?args.slice(1):[null,null,...args.slice(1)];
const config=live?require('dotenv').parse(fs.readFileSync(envFile)):{};
const nonce=randomUUID().replaceAll('-',''),branch='TEST_'+nonce.slice(0,12).toUpperCase();
const marker='HISTORYTEST-'+nonce.toUpperCase(),deviceId=marker+'-DEVICE',receipts=[];
const members=[],report={checkedAt:new Date().toISOString(),mode:live?'live':'local',adaAccAccessed:false,appInstalled:false};
let db,pool,server,admin,localDbName,base,token,stage='connect';
fs.mkdirSync(output,{recursive:true});
async function send(route,method='GET',body,auth=token){
 const response=await fetch(base+route,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(auth?{Authorization:'Bearer '+auth}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
 return {status:response.status,data:await response.json()};
}
async function desktop(historyOnly,expectedCount){
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(path.resolve(helper),['--live'],{stdio:['pipe','pipe','pipe'],windowsHide:true});let stdout='';
  const timeout=setTimeout(()=>{child.kill();reject(Error('DESKTOP_TIMEOUT'));},150000);
  child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',()=>{});child.on('error',reject);
  child.on('close',code=>{clearTimeout(timeout);try{const result=JSON.parse(stdout.trim());assert.equal(code,0,JSON.stringify(result));assert.equal(result.ok,true);resolve(result);}catch(error){reject(error);}});
  child.stdin.end(JSON.stringify({BaseUrl:base,StaffToken:token,MemberId:members[0].id,Phone:members[0].phone,OtherMemberId:members[1].id,OtherPhone:members[1].phone,BranchCode:branch,ReceiptPrefix:marker+'-',OutputDirectory:path.resolve(output),HistoryOnly:historyOnly,ExpectedCount:expectedCount}));
 });
 return result;
}
async function connect(){
 if(live){
  const url=new URL(config.SC_OFFICIAL_SUPABASE_DATABASE_URL);
  assert.ok(['.supabase.com','.supabase.co'].some(s=>url.hostname.endsWith(s)));
  for(const key of ['sslmode','sslcert','sslkey','sslrootcert'])assert.equal(url.searchParams.has(key),false);
  db=new Client({connectionString:url.href,ssl:{rejectUnauthorized:true,ca:fs.readFileSync(caFile,'utf8')},connectionTimeoutMillis:10000,query_timeout:20000});await db.connect();base='https://sc-official-website.onrender.com';
 }else{
  localDbName='sccrm_history_test_'+nonce;
  admin=new Client({connectionString:'postgresql://postgres@127.0.0.1:55441/postgres',ssl:false});await admin.connect();await admin.query('CREATE DATABASE '+localDbName);
  const connectionString='postgresql://postgres@127.0.0.1:55441/'+localDbName;
  db=new Client({connectionString,ssl:false});await db.connect();
  await db.query(fs.readFileSync(path.join(__dirname,'../migrations/202610200001_crm_counter_bootstrap.sql'),'utf8'));
  await require('./provision-central-promotions.cjs').provisionCentralPromotions(db,{apply:true});
  await require('./provision-purchase-history.cjs').provisionPurchaseHistory(db,{apply:true});
  Object.assign(process.env,{SC_OFFICIAL_SUPABASE_DATABASE_URL:connectionString,SCCRM_STAFF_PIN:'synthetic-history-pin',SCCRM_REFRESH_TOKEN_SECRET:'synthetic-history-secret',SCCRM_ALLOWED_STAFF_DEVICE_NAMES:'synthetic-history-device'});
  const express=require('express');pool=require('../db');const app=express();
  app.use('/join',require('../routes/publicMemberRegistration').createPublicMemberRegistration({pool,maxRequests:1000}));app.use(express.json());app.use('/api/sccrm',require('../routes/sccrm'));app.use('/api/members',require('../routes/loyalty'));app.use('/api/loyalty',require('../routes/loyalty'));
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});base='http://127.0.0.1:'+server.address().port;
 }
 db.on('error',()=>{});report.database=live?'existing Supabase':'isolated local PostgreSQL';
}
async function verify(){
 stage='owned-members-and-staff';
 const names=String((live?config.SCCRM_ALLOWED_STAFF_DEVICE_NAMES:process.env.SCCRM_ALLOWED_STAFF_DEVICE_NAMES)||'').split(',').map(s=>s.trim()).filter(Boolean);
 const auth=await send('/api/sccrm/auth/staff-device','POST',{deviceId,deviceName:names[0]||'synthetic-history-device',pin:live?config.SCCRM_STAFF_PIN:process.env.SCCRM_STAFF_PIN},null);
 assert.equal(auth.status,200);token=auth.data.staffToken;
 for(const [index,method] of ['QR','STAFF'].entries()){
  let phone;for(;;){phone='099'+String(randomInt(10000000)).padStart(7,'0');if(!(await db.query('SELECT 1 FROM users WHERE phone_number=$1',[phone])).rowCount)break;}
  const name=marker+' '+method;members.push({phone,name});
  const created=index===0?await send('/join/submit','POST',{firstName:marker,lastName:method,phone,consent:true},null):await send('/api/members','POST',{name,phone});
  assert.ok([200,201].includes(created.status));
  const row=await db.query('SELECT id FROM users WHERE phone_number=$1 AND full_name=$2',[phone,name]);assert.equal(row.rowCount,1);members[index].id=row.rows[0].id;
 }
 stage='actual-winforms-selection-confirmation';
 receipts.push(...['MIXED','ZERO','OTHER'].map(s=>marker+'-'+s));
 report.desktop=await desktop(false,2);
 stage='database-readback';
 const claims=await db.query('SELECT id,receipt_no,user_id,total_amount,receipt_total_amount,receipt_snapshot,(SELECT count(*)::int FROM loyalty_claim_items i WHERE i.claim_id=c.id) AS lines FROM loyalty_claims c WHERE branch_code=$1 AND receipt_no=ANY($2::text[])',[branch,receipts]);
 assert.equal(claims.rowCount,3);
 const mixed=claims.rows.find(r=>r.receipt_no===receipts[0]),zero=claims.rows.find(r=>r.receipt_no===receipts[1]);
 assert.equal(mixed.user_id,members[0].id);assert.equal(Number(mixed.total_amount),350);assert.equal(Number(mixed.receipt_total_amount),340);assert.equal(mixed.lines,2);
 assert.deepEqual(mixed.receipt_snapshot.items.map(i=>i.seq),[3,5]);assert.equal(mixed.receipt_snapshot.items[0].barcode,'SYNTHETIC-BC');assert.equal(mixed.receipt_snapshot.items[0].lineDiscount,10);assert.equal(mixed.receipt_snapshot.items[0].promotionCode,'TEST-PROMO');assert.equal(zero.lines,1);assert.equal(Number(zero.total_amount),100);
 const medicineAward=await db.query('SELECT amount FROM point_ledger WHERE reference_id=$1',[zero.id]);assert.equal(medicineAward.rowCount,1);assert.equal(Number(medicineAward.rows[0].amount),4);
 const mirror=await db.query('SELECT paid_total,pos_code,cashier_code FROM crm_pos_sale_events WHERE branch_code=$1 AND doc_no=$2',[branch,receipts[0]]);
 assert.equal(Number(mirror.rows[0].paid_total),340);assert.equal(mirror.rows[0].pos_code,'TEST-POS');
 const oldShape={receiptNo:marker+'-OLDER-REQUEST',branchCode:branch,memberId:members[0].id,totalAmount:250,previewPoints:99999,items:mixed.receipt_snapshot.items};
 receipts.push(oldShape.receiptNo);const oldClaim=await send('/api/loyalty/claims','POST',oldShape);assert.equal(oldClaim.status,201);assert.equal(oldClaim.data.awardedPoints,14);assert.equal(oldClaim.data.eligibleAmount,350);
 const repeated={...oldShape,receiptNo:receipts[0],memberId:members[1].id};
 assert.equal((await send('/api/loyalty/claims','POST',repeated)).status,409);
 assert.equal((await db.query('SELECT user_id FROM loyalty_claims WHERE id=$1',[mixed.id])).rows[0].user_id,members[0].id);
 stage='pagination-and-member-isolation';
 if(!live){
  for(let i=1;i<=105;i++)receipts.push(marker+'-PAGE-'+i);
  await db.query(`INSERT INTO loyalty_claims(id,receipt_no,branch_code,sold_at,total_amount,awarded_points,user_id,created_at)
   SELECT $1||'-PAGE-'||i,$1||'-PAGE-'||i,$2,'2000-01-01 00:00:00.123456+00',0,0,$3,'2000-01-01 00:00:00.654321+00' FROM generate_series(1,105) AS i`,[marker,branch,members[0].id]);
 }
 const route='/api/members/'+members[0].id+'/purchase-history',seen=[];let cursor;
 do {
  const history=await send(route+'?limit=1'+(cursor?'&cursor='+encodeURIComponent(cursor):''));assert.equal(history.status,200);assert.ok(history.data.purchases.length<=1);
  for(const p of history.data.purchases){assert.notEqual(p.receiptNo,marker+'-OTHER');seen.push(p.claimId);if(p.receiptNo===oldShape.receiptNo)assert.equal(p.totalAmountSource,'item_sum');}
  cursor=history.data.nextCursor;
 }while(cursor);
 assert.equal(seen.length,live?3:108);assert.equal(new Set(seen).size,seen.length);
 report.reopenedDesktop=await desktop(true,live?3:108);
 assert.equal((await send(route,'GET',null,null)).status,401);
 await db.query('UPDATE staff_devices SET revoked_at=NOW() WHERE device_id=$1',[deviceId]);
 assert.equal((await send(route)).status,401);
 report.readback={confirmedBills:3,qrAndStaffMembers:true,allReceiptLinesStored:true,originalPaidTotal:340,eligibleAmount:350,medicineOnlyPoints:4,duplicateRejected:true,memberIsolation:true,revokedSessionDenied:true,historyRowsTraversed:seen.length,originalItemOrderAndMetadata:true,olderRequestAccepted:true};
 report.applicationSha256=createHash('sha256').update(fs.readFileSync(path.join(path.dirname(helper),'SCCRMonPOS.exe'))).digest('hex');
}
async function cleanup(){
 if(!db)return;await db.query('BEGIN');try{
  await db.query('DELETE FROM crm_pos_sale_events WHERE branch_code=$1 AND doc_no=ANY($2::text[])',[branch,receipts]);
  await db.query('DELETE FROM loyalty_claims WHERE branch_code=$1 AND receipt_no=ANY($2::text[])',[branch,receipts]);
  for(const m of members)await db.query('DELETE FROM users WHERE phone_number=$1 AND full_name=$2',[m.phone,m.name]);
  await db.query('DELETE FROM staff_devices WHERE device_id=$1',[deviceId]);
  const remains=await db.query('SELECT (SELECT count(*) FROM loyalty_claims WHERE branch_code=$1)+(SELECT count(*) FROM crm_pos_sale_events WHERE branch_code=$1)+(SELECT count(*) FROM users WHERE full_name=ANY($2::text[]))+(SELECT count(*) FROM staff_devices WHERE device_id=$3) AS n',[branch,members.map(m=>m.name),deviceId]);assert.equal(Number(remains.rows[0].n),0);
  await db.query('COMMIT');report.syntheticFixturesRemoved=true;report.remainingFixtureRows=0;
 }catch(error){await db.query('ROLLBACK');throw error;}
}
(async()=>{
 let failure;try{await connect();await verify();}catch(error){failure=error;report.error={stage,code:error.code||'VERIFICATION_FAILED',...(live?{}:{message:error.message})};process.exitCode=1;}
 finally{try{await cleanup();}catch(error){failure=error;report.cleanupFailed=true;process.exitCode=1;}if(server)await new Promise(resolve=>server.close(resolve));if(pool)await pool.end();if(db)await db.end();if(admin){if(/^sccrm_history_test_[a-f0-9]{32}$/.test(localDbName))await admin.query('DROP DATABASE '+localDbName);await admin.end();}}
 report.ok=!failure;fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
})();
