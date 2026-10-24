'use strict';
// Deliberately separate from migrations: this runner accepts a fresh local test
// database only. It never opens native SQL Server or a cloud database.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{Pool}=require('pg');
const url=new URL(process.env.SC_OFFICIAL_ADA_LINK_TEST_DATABASE_URL||'http://invalid');
if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost'].includes(url.hostname)||!['5432','5433','55444'].includes(url.port)||!/^\/sccrm_ada_link_test_[a-z0-9_]+$/.test(url.pathname))throw Error('FRESH_LOCAL_LINK_TEST_DATABASE_REQUIRED');
const pool=new Pool({connectionString:url.toString(),max:4,connectionTimeoutMillis:5000,statement_timeout:10000});
const dbFile=require.resolve('../db');require.cache[dbFile]={id:dbFile,filename:dbFile,loaded:true,exports:pool};
process.env.SC_OFFICIAL_ADA_SYNC_ENABLED='true';process.env.SC_OFFICIAL_ADA_LINK_ADMIN_TOKEN='synthetic-local-copy-admin-credential-no-live-access';
const api=require('../lib/adaMemberLinking'),SOURCE='hq000/AdaAcc',checks=[];
const check=(name,ok)=>{assert.ok(ok,name);checks.push(name);};
const sha=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const ids=Object.fromEntries('ABCDEFGZH'.split('').map(k=>[k,crypto.randomUUID()]));
const profiles={A:'0990000001',B:'0990000001',C:'0990000002',D:'0990000003',E:'0990000004',F:'0990000004',G:'0990000001',Z:'0990000001',H:'0990000009'};
const actor={id:'synthetic-local-admin',role:'admin'};
async function choice(key,code){const options=await api.linkOptions(ids[key]);return {adaCode:code,reviewToken:options.candidates.find(c=>c.adaCode===code).reviewToken,actor};}
async function reject(name,fn,code){await assert.rejects(fn,e=>e.code===code);checks.push(name);}
async function main(){try{
 check('fresh_local_database',(await pool.query("SELECT to_regclass('public.users') n")).rows[0].n===null);
 await pool.query(`CREATE TABLE public.users(id uuid PRIMARY KEY,full_name text,phone_number text,email text);
 CREATE TABLE public.member_profiles(user_id uuid PRIMARY KEY REFERENCES public.users,member_code text,is_active boolean DEFAULT true,created_at timestamptz DEFAULT now());
 CREATE TABLE public.loyalty_claims(id text PRIMARY KEY,user_id uuid,receipt_no text,branch_code text);
 CREATE TABLE public.point_ledger(id uuid PRIMARY KEY,user_id uuid,amount integer);`);
 await pool.query(fs.readFileSync(path.resolve(__dirname,'../sql/ada-member-mirror.sql'),'utf8'));
 for(const[k,id]of Object.entries(ids)){await pool.query('INSERT INTO public.users VALUES($1,$2,$3,NULL)',[id,'Synthetic '+k,profiles[k]]);await pool.query('INSERT INTO public.member_profiles(user_id,member_code,is_active) VALUES($1,$2,$3)',[id,'SC-TEST-'+k,k!=='G']);}
 for(const[code,phone]of [['A-1',profiles.A],['A-2',profiles.A],['A-3',profiles.A],['A-4',profiles.C],['A-5',profiles.D],['A-6',profiles.E]]){
  const payload={FTCstCode:code,FTCstName:'Synthetic native '+code,FTCstTel:phone,openingPoints:12};
  await pool.query('INSERT INTO ada_history.customers(source_id,ada_code,name,phone,active,branch_code,source_payload,payload_hash,source_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[SOURCE,code,payload.FTCstName,phone,'1','001',payload,sha(payload),crypto.randomUUID()]);
 }
 await pool.query('INSERT INTO ada_history.member_links VALUES($1,$2,$3,$4)',[ids.Z,SOURCE,'A-3','preexisting test owner']);
 for(const[code,doc,type]of [['A-1','BILL-OTHER','1'],['A-2','BILL-A','1'],['A-2','BILL-A2','1'],['A-2','RETURN-A','9'],['A-5','BILL-CONFLICT','1']]){
  const key=sha(doc),raw={FDShdDocDate:'2026-10-20T00:00:00.000',FTShdDocTime:'10:11:12'};
  await pool.query(`INSERT INTO ada_history.receipts(source_id,receipt_key,branch_code,pos_code,doc_no,doc_type,customer_code,sale_date,sale_time,grand_total,source_payload,payload_hash,source_snapshot) VALUES($1,$2,'001','001',$3,$4,$5,'2026-10-20','10:11:12',40,$6,$7,$8)`,[SOURCE,key,doc,type,code,raw,sha(raw),crypto.randomUUID()]);
  await pool.query(`INSERT INTO ada_history.lines(source_id,line_key,receipt_key,seq,sku,product_name,unit_code,unit_name,quantity,line_total,source_payload,payload_hash,source_snapshot) VALUES($1,$2,$3,1,'SKU-TEST','Synthetic product','BOX','กล่อง',2,40,$4,$5,$6)`,[SOURCE,sha('line:'+doc),key,{test:doc},sha(doc),crypto.randomUUID()]);
 }
 await pool.query('INSERT INTO public.loyalty_claims VALUES($1,$2,$3,$4)',['claim-other',ids.Z,'BILL-CONFLICT','001']);
 const fingerprint=async()=>sha({customers:(await pool.query('SELECT ada_code,source_payload,payload_hash FROM ada_history.customers ORDER BY ada_code')).rows,receipts:(await pool.query('SELECT * FROM ada_history.receipts ORDER BY receipt_key')).rows,lines:(await pool.query('SELECT * FROM ada_history.lines ORDER BY line_key')).rows,users:(await pool.query('SELECT * FROM public.users ORDER BY id')).rows,points:(await pool.query('SELECT * FROM public.point_ledger ORDER BY id')).rows});
 const before=await fingerprint(),pending=await api.pendingLinks();check('pending_excludes_linked_inactive_and_nonmatching_members',pending.total===6&&pending.members.every(m=>!['G','Z','H'].some(k=>ids[k]===m.id)));
 const options=await api.linkOptions(ids.A);check('same_phone_codes_remain_separate_choices',options.candidates.length===3&&new Set(options.candidates.map(c=>c.adaCode)).size===3);
 check('existing_binding_is_visible_for_disabled_UI_choice',options.candidates.find(c=>c.adaCode==='A-3').linkedMemberId===ids.Z);
 const selected=await choice('A','A-2'),result=await api.confirmLink(ids.A,selected);check('explicit_second_code_is_linked_not_first_match',result.adaCode==='A-2'&&!result.alreadyLinked);
 const nativeHistory=(await pool.query('SELECT receipt_no,receipt_total_amount FROM ada_history.purchase_claims WHERE user_id=$1 ORDER BY receipt_no',[ids.A])).rows;
 check('selected_native_history_moves_to_exact_member_without_other_codes',nativeHistory.length===3&&nativeHistory.every(r=>r.receipt_no!=='BILL-OTHER'));
 check('native_return_remains_a_negative_document',Number(nativeHistory.find(r=>r.receipt_no==='RETURN-A').receipt_total_amount)===-40);
 const reference=(await pool.query('SELECT approval_reference FROM ada_history.member_links WHERE member_id=$1',[ids.A])).rows[0].approval_reference;
 check('authenticated_admin_is_recorded_in_approval',JSON.parse(reference).actorId===actor.id);
 check('same_confirmation_replay_is_idempotent',(await api.confirmLink(ids.A,selected)).alreadyLinked===true);
 check('replay_preserves_original_approval',(await pool.query('SELECT approval_reference FROM ada_history.member_links WHERE member_id=$1',[ids.A])).rows[0].approval_reference===reference);
 check('pending_ignores_resolved_historical_review',!(await api.pendingLinks()).members.some(m=>m.id===ids.A));
 await reject('cannot_reassign_code_to_another_member',async()=>api.confirmLink(ids.B,await choice('B','A-2')),'ADA_ALREADY_LINKED');
 await reject('cannot_move_an_already_linked_member_to_another_code',async()=>api.confirmLink(ids.A,await choice('A','A-1')),'MEMBER_ALREADY_LINKED');
 await reject('a_signed_option_is_bound_to_the_requested_member',()=>api.confirmLink(ids.B,selected),'INVALID_LINK');
 const stale=await choice('C','A-4'),now=Date.now;try{Date.now=()=>now()+11*60000;await reject('expired_preview_cannot_create_a_link',()=>api.confirmLink(ids.C,stale),'OPTIONS_EXPIRED');}finally{Date.now=now;}
 const oldHash=(await pool.query("SELECT payload_hash FROM ada_history.customers WHERE ada_code='A-4'")).rows[0].payload_hash;
 await pool.query("UPDATE ada_history.customers SET payload_hash=$1 WHERE ada_code='A-4'",['f'.repeat(64)]);
 await reject('changed_native_snapshot_requires_fresh_review',()=>api.confirmLink(ids.C,stale),'PHONE_CHANGED');
 await pool.query("UPDATE ada_history.customers SET payload_hash=$1 WHERE ada_code='A-4'",[oldHash]);
 await pool.query('UPDATE public.users SET phone_number=$1 WHERE id=$2',['0990000008',ids.C]);
 await reject('changed_member_phone_requires_fresh_review',()=>api.confirmLink(ids.C,stale),'PHONE_CHANGED');
 await pool.query('UPDATE public.users SET phone_number=$1 WHERE id=$2',[profiles.C,ids.C]);
 check('fresh_review_recovers_after_stale_rejections',!(await api.confirmLink(ids.C,await choice('C','A-4'))).alreadyLinked);
 await reject('existing_receipt_ownership_is_never_reassigned',async()=>api.confirmLink(ids.D,await choice('D','A-5')),'BILL_OWNER_CONFLICT');
 const competing=await Promise.all([choice('E','A-6'),choice('F','A-6')]);
 const race=await Promise.allSettled([api.confirmLink(ids.E,competing[0]),api.confirmLink(ids.F,competing[1])]);
 check('two_concurrent_admins_cannot_bind_one_code_twice',race.filter(r=>r.status==='fulfilled').length===1&&race.filter(r=>r.status==='rejected'&&r.reason.code==='ADA_ALREADY_LINKED').length===1);
 check('failed_attempts_create_no_partial_or_duplicate_links',(await pool.query('SELECT count(*)::int n FROM ada_history.member_links')).rows[0].n===4);
 check('all_original_source_profile_receipt_line_user_and_point_fixtures_unchanged',before===await fingerprint());
 console.log(JSON.stringify({ok:true,checks:checks.length,passed:checks,nativeSqlConnections:0,cloudConnections:0,testDatabase:url.pathname.slice(1)}));
 }finally{await pool.end();}}
main().catch(e=>{console.error(JSON.stringify({ok:false,code:e.code||e.message}));process.exitCode=1;});
