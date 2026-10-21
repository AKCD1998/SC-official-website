'use strict';
// Opt-in real integration check. Live mode writes only nonce-scoped synthetic
// members/devices/receipts/promotions and deletes only those exact owned rows.
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,randomInt,createHash}=require('node:crypto');
const {spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const {Client}=require('pg');
const dotenv=require('dotenv');
const args=process.argv.slice(2);
const live=args[0]==='--live';
if(!['--live','--local'].includes(args[0]) || args.length!==6)throw Error('MODE_AND_SIX_ARGUMENTS_REQUIRED');
const [,envFile,caFile,helper,oldExe,newExe]=args;
const config=live?dotenv.parse(fs.readFileSync(envFile)):{};
const nonce=randomUUID().replaceAll('-','');
const branch='TEST_'+nonce.slice(0,12).toUpperCase();
const marker='PROMOTEST-'+nonce.toUpperCase();
const deviceIds=[marker+'-old',marker+'-new'];
const report={checkedAt:new Date().toISOString(),mode:live?'live':'local',adaAccAccessed:false,appInstalledOrUpdated:false,stages:[]};
let db,pool,server,adminDb,base,phone,memberId,adminId,adminToken,stage='connect';
const promotionIds=[randomUUID(),randomUUID()];
const receipts=[];
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function send(route,method='GET',body,token){const res=await fetch(base+route,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(25000)});let data;try{data=await res.json()}catch{data={}}return {status:res.status,data};}
async function desktop(exe,token,receiptNo,expectedPoints,duplicate=false){
 return new Promise((resolve,reject)=>{
  const child=spawn(helper,[exe],{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='';
  child.stdout.on('data',c=>output+=c.toString());child.stderr.resume();
  const timer=setTimeout(()=>{child.kill();reject(Error('COMPATIBILITY_HELPER_TIMEOUT'));},90000);
  child.on('error',e=>{clearTimeout(timer);reject(e)});
  child.on('close',code=>{clearTimeout(timer);try{const data=JSON.parse(output.trim());assert.equal(code,0,JSON.stringify(data));assert.equal(data.ok,true);resolve(data);}catch(e){reject(e)}});
  child.stdin.end(JSON.stringify({BaseUrl:base,StaffToken:token,MemberId:memberId,Phone:phone,BranchCode:branch,ReceiptNo:receiptNo,Amount:250,ExpectedPoints:expectedPoints,Duplicate:duplicate}));
 });
}
async function connect(){
 if(live){const url=new URL(config.SC_OFFICIAL_SUPABASE_DATABASE_URL);assert.ok(['.supabase.com','.supabase.co'].some(s=>url.hostname.endsWith(s)));for(const key of ['sslmode','sslcert','sslkey','sslrootcert'])assert.equal(url.searchParams.has(key),false);
  db=new Client({connectionString:url.href,ssl:{rejectUnauthorized:true,ca:fs.readFileSync(caFile,'utf8')},connectionTimeoutMillis:10000,query_timeout:20000});await db.connect();base='https://sc-official-website.onrender.com';
  assert.equal(hash(oldExe),'2cc37eec1426ffd68813a04e184cfd0770dce99f242cf5c509753d84f1bcae0d');
 }else{
  const name='sccrm_promo_test_'+nonce;adminDb=new Client({connectionString:'postgresql://postgres@127.0.0.1:55441/postgres',ssl:false});await adminDb.connect();await adminDb.query('CREATE DATABASE '+name);
  const connectionString='postgresql://postgres@127.0.0.1:55441/'+name;
  db=new Client({connectionString,ssl:false});await db.connect();await db.query(fs.readFileSync(path.join(__dirname,'../migrations/202610200001_crm_counter_bootstrap.sql'),'utf8'));
  await require('./provision-central-promotions.cjs').provisionCentralPromotions(db,{apply:true});
  Object.assign(process.env,{SC_OFFICIAL_SUPABASE_DATABASE_URL:connectionString,SCCRM_STAFF_PIN:'synthetic-fixture-pin',SCCRM_REFRESH_TOKEN_SECRET:'synthetic-fixture-secret',SCCRM_ALLOWED_STAFF_DEVICE_NAMES:'synthetic-promotion-fixture',JWT_SECRET:'synthetic-admin-fixture',SCCRM_PROMOTION_ADMIN_EMAILS:marker.toLowerCase()+'@example.invalid'});
  const express=require('express');pool=require('../db');const app=express();
  app.use('/join',require('../routes/publicMemberRegistration').createPublicMemberRegistration({pool,maxRequests:1000}));app.use('/sccrm/promotions',require('../routes/promotionPortal'));app.use(express.json());app.use('/api/sccrm',require('../routes/sccrm'));app.use('/api/loyalty',require('../routes/loyalty'));app.use('/api/members',require('../routes/loyalty'));app.use('/api/auth',require('../routes/auth'));
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});base='http://127.0.0.1:'+server.address().port;
  const password='synthetic-test-only-password';
  const setupToken=require('jsonwebtoken').sign({scope:'promotion-admin-setup',email:process.env.SCCRM_PROMOTION_ADMIN_EMAILS},require('../lib/promotionAdminSetup').setupSigningSecret(),{algorithm:'HS256',audience:'sccrm-promotion-admin-setup',issuer:'sccrm-admin-operator',jwtid:randomUUID(),expiresIn:'1h'});
  assert.equal((await send('/api/sccrm/promotions/admin/setup','POST',{setupToken,password})).status,201);
  assert.equal((await send('/api/sccrm/promotions/admin/setup','POST',{setupToken,password})).status,409);
  adminId=(await db.query('SELECT id FROM users WHERE email=$1',[process.env.SCCRM_PROMOTION_ADMIN_EMAILS])).rows[0].id;
  await db.query('UPDATE users SET full_name=$2 WHERE id=$1',[adminId,marker+' admin']);
  const login=await send('/api/auth/login','POST',{email:process.env.SCCRM_PROMOTION_ADMIN_EMAILS,password});assert.equal(login.status,200);adminToken=login.data.token;
 }
 db.on('error',()=>{});report.database=live?'existing Supabase':'isolated local PostgreSQL';report.binarySha256={old:hash(oldExe),new:hash(newExe)};
}
async function savePromotion(index,value,type='multiplier',active=true,endsAt=null){
 const body={name:marker+' '+type,type,value,condition_json:{branch_codes:[branch],minimum_spend:200},is_active:active,ends_at:endsAt};
 if(adminToken){const existing=await db.query('SELECT 1 FROM promotions WHERE id=$1',[promotionIds[index]]);const response=await send('/api/sccrm/promotions'+(existing.rowCount?'/'+promotionIds[index]:''),existing.rowCount?'PUT':'POST',body,adminToken);assert.ok([200,201].includes(response.status));promotionIds[index]=response.data.promotionId;}
 else await db.query(`INSERT INTO promotions(id,name,type,value,condition_json,is_active,ends_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)
 ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value,is_active=EXCLUDED.is_active,ends_at=EXCLUDED.ends_at,updated_at=NOW()`,[promotionIds[index],body.name,type,value,JSON.stringify(body.condition_json),active,endsAt]);
}
async function pair(tokens,label,expected){
 const docs=['OLD','NEW'].map(s=>marker+'-'+label+'-'+s);receipts.push(...docs);
 const results=await Promise.all([desktop(oldExe,tokens[0],docs[0],expected),desktop(newExe,tokens[1],docs[1],expected)]);
 assert.equal(results[0].catalogRevision,results[1].catalogRevision);assert.deepEqual(results[0].promotionIds,results[1].promotionIds);
 assert.equal(results[0].applicationVersion,'1.1.0.0');assert.equal(results[1].applicationVersion,'1.2.0.0');
 report.stages.push({label,expectedPoints:expected,clients:results});return docs;
}
async function verify(){
 stage='fixture-registration';
 for(;;){phone='099'+String(randomInt(10000000)).padStart(7,'0');if(!(await db.query('SELECT 1 FROM users WHERE phone_number=$1',[phone])).rowCount)break;}
 const join=await send('/join/submit','POST',{firstName:marker,lastName:'QR fixture',phone,consent:true});assert.ok([200,201].includes(join.status));
 const member=await db.query('SELECT id FROM users WHERE phone_number=$1 AND full_name=$2',[phone,marker+' QR fixture']);assert.equal(member.rowCount,1);memberId=member.rows[0].id;
 const names=String((live?config.SCCRM_ALLOWED_STAFF_DEVICE_NAMES:process.env.SCCRM_ALLOWED_STAFF_DEVICE_NAMES)||'').split(',').map(s=>s.trim()).filter(Boolean);
 const tokens=[];for(const id of deviceIds){const login=await send('/api/sccrm/auth/staff-device','POST',{deviceId:id,deviceName:names[0]||'synthetic-promotion-fixture',pin:live?config.SCCRM_STAFF_PIN:process.env.SCCRM_STAFF_PIN});assert.equal(login.status,200);tokens.push(login.data.staffToken);}
 stage='admin-boundary';assert.equal((await send('/api/sccrm/promotions','POST',{name:'must not create'},tokens[0])).status,401);
 stage='double-points';await savePromotion(0,2);const first=await pair(tokens,'DOUBLE',20);
 const global=await send('/api/sccrm/promotions/active');assert.equal(global.data.promotions.some(p=>promotionIds.includes(p.id)),false);
 stage='changed-rules-same-binaries';await savePromotion(0,3);await savePromotion(1,5,'threshold');await pair(tokens,'TRIPLE-BONUS',35);
 stage='disabled-expired';await savePromotion(0,3,'multiplier',false);await savePromotion(1,5,'threshold',true,new Date(Date.now()-60000).toISOString());await pair(tokens,'BASE',10);
 stage='duplicate-replay';report.duplicate=await desktop(oldExe,tokens[0],first[0],10,true);
 stage='database-readback';
 const rows=await db.query('SELECT awarded_points,promotion_snapshot,promotion_revision,preview_points FROM loyalty_claims WHERE branch_code=$1 ORDER BY created_at',[branch]);assert.equal(rows.rowCount,6);assert.deepEqual(rows.rows.map(r=>r.awarded_points),[20,20,35,35,10,10]);assert.ok(rows.rows.every(r=>r.preview_points===999999));assert.ok(rows.rows.slice(0,2).every(r=>r.promotion_snapshot[0].value===2));
 const balance=Number((await db.query('SELECT SUM(amount) AS balance FROM point_ledger WHERE user_id=$1',[memberId])).rows[0].balance);assert.equal(balance,130);
 assert.equal(Number((await db.query('SELECT count(*) FROM crm_loyalty_awards WHERE customer_account_id=$1',[memberId])).rows[0].count),6);
 report.databaseReadback={claims:6,pointsBalance:balance,immutablePromotionSnapshots:true,clientPreviewIgnored:true,duplicatePrevented:true};
 report.binaryHashesUnchanged=hash(oldExe)===report.binarySha256.old && hash(newExe)===report.binarySha256.new;assert.equal(report.binaryHashesUnchanged,true);
}
async function cleanup(){
 if(!db)return;await db.query('BEGIN');try{
  await db.query('DELETE FROM crm_pos_sale_events WHERE branch_code=$1 AND doc_no=ANY($2::text[])',[branch,receipts]);
  await db.query('DELETE FROM loyalty_claims WHERE branch_code=$1 AND receipt_no=ANY($2::text[])',[branch,receipts]);
  if(memberId)await db.query('DELETE FROM users WHERE id=$1 AND phone_number=$2 AND full_name=$3',[memberId,phone,marker+' QR fixture']);
  else if(phone)await db.query('DELETE FROM users WHERE phone_number=$1 AND full_name=$2',[phone,marker+' QR fixture']);
  await db.query('DELETE FROM promotions WHERE id=ANY($1::uuid[]) AND name LIKE $2',[promotionIds,marker+'%']);
  await db.query('DELETE FROM staff_devices WHERE device_id=ANY($1::text[])',[deviceIds]);
  if(adminId)await db.query('DELETE FROM users WHERE id=$1 AND full_name=$2',[adminId,marker+' admin']);
  const remains=await db.query(`SELECT (SELECT count(*) FROM loyalty_claims WHERE branch_code=$1)+(SELECT count(*) FROM crm_pos_sale_events WHERE branch_code=$1)+(SELECT count(*) FROM promotions WHERE id=ANY($2::uuid[]))+(SELECT count(*) FROM staff_devices WHERE device_id=ANY($3::text[]))+(SELECT count(*) FROM users WHERE full_name=ANY($4::text[])) AS count`,[branch,promotionIds,deviceIds,[marker+' QR fixture',marker+' admin']]);
  assert.equal(Number(remains.rows[0].count),0);await db.query('COMMIT');report.syntheticFixturesRemoved=true;report.remainingFixtureRows=0;
 }catch(e){await db.query('ROLLBACK');throw e;}
}
(async()=>{let failure;try{await connect();await verify();}catch(e){failure=e;report.error={stage,code:e.code||'VERIFICATION_FAILED',...(live?{}:{message:e.message})};process.exitCode=1;}
 finally{try{await cleanup();}catch(e){report.cleanupFailed=true;report.cleanupError={code:e.code||'CLEANUP_FAILED',...(live?{}:{message:e.message})};process.exitCode=1;failure=e;}if(server)await new Promise(resolve=>server.close(resolve));if(pool)await pool.end();if(db)await db.end();if(adminDb)await adminDb.end();}
 report.ok=!failure;fs.writeFileSync(path.resolve(process.cwd(),'promotion-compatibility-'+(live?'live':'local')+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));})();
