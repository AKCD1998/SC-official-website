'use strict';
const fs=require('node:fs');const path=require('node:path');const {Client}=require('pg');
const filename='202610240001_member_portal_email_auth.sql';
const tables=['member_portal_email_otps','member_portal_sessions'];
async function provisionMemberPortal(client,{apply=false}={}) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout='1s'");await client.query("SET LOCAL statement_timeout='15s'");
    await client.query('SELECT pg_advisory_xact_lock(20261024,65)');
    const base=await client.query("SELECT to_regclass('public.users') IS NOT NULL AND to_regclass('public.member_profiles') IS NOT NULL AND to_regclass('public.crm_counter_schema_migrations') IS NOT NULL AS ready");
    if(!base.rows[0].ready)throw Error('CRM_BOOTSTRAP_REQUIRED');
    const ledger=await client.query('SELECT 1 FROM public.crm_counter_schema_migrations WHERE filename=$1',[filename]);
    const existing=await client.query("SELECT COUNT(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])",[tables]);
    if(existing.rows[0].count!==0 && !(ledger.rowCount===1 && existing.rows[0].count===2))throw Error('EXISTING_SCHEMA_REQUIRES_REVIEW');
    if(ledger.rowCount!==1)await client.query(fs.readFileSync(path.join(__dirname,'../migrations',filename),'utf8'));
    const privacy=await client.query("SELECT COUNT(*)::int AS count,bool_and(c.relrowsecurity) AS rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND c.relkind='r'",[tables]);
    if(privacy.rows[0].count!==2 || !privacy.rows[0].rls)throw Error('PRIVACY_CHECK_FAILED');
    await client.query(apply?'COMMIT':'ROLLBACK');
    return {status:apply?'applied':'dry-run-rolled-back',filename,alreadyApplied:ledger.rowCount===1,tablesVerified:2,rowLevelSecurity:true,memberRowsChanged:false,receiptRowsChanged:false,unrelatedMigrationsRun:false};
  }catch(error){await client.query('ROLLBACK');throw error;}
}
async function main(){
  if(process.argv.slice(2).some(arg=>arg!=='--apply'))throw Error('UNSUPPORTED_MODE');
  const raw=process.env.SC_OFFICIAL_SUPABASE_DATABASE_URL;if(!raw)throw Error('DATABASE_REQUIRED');
  const url=new URL(raw);if(!['postgres:','postgresql:'].includes(url.protocol)||!/\.(supabase\.co|supabase\.com)$/i.test(url.hostname))throw Error('SUPABASE_HOST_REQUIRED');
  for(const key of ['sslmode','sslcert','sslkey','sslrootcert'])if(url.searchParams.has(key))throw Error('TLS_OVERRIDE_REFUSED');
  const ca=process.env.CRM_BOOTSTRAP_TLS_CA_FILE;
  const client=new Client({connectionString:raw,ssl:{rejectUnauthorized:true,...(ca?{ca:fs.readFileSync(ca,'utf8')}:{})},connectionTimeoutMillis:8000,query_timeout:18000});
  client.on('error',()=>{});try{await client.connect();console.log(JSON.stringify(await provisionMemberPortal(client,{apply:process.argv.includes('--apply')})));}finally{await client.end();}
}
module.exports={provisionMemberPortal,filename,tables};
if(require.main===module)main().catch(()=>{console.error('{"status":"stopped","code":"MEMBER_PORTAL_PROVISION_FAILED","detailsWithheld":true}');process.exitCode=1;});
