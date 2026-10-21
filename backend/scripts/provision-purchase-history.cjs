'use strict';
const fs=require('node:fs'),path=require('node:path'),{Client}=require('pg');
const filename='202610210002_purchase_history.sql';
async function provisionPurchaseHistory(client,{apply=false}={}){
 await client.query('BEGIN');try{
  await client.query("SET LOCAL lock_timeout='1s'");await client.query("SET LOCAL statement_timeout='15s'");await client.query('SET LOCAL search_path=public');await client.query('SELECT pg_advisory_xact_lock(20261021,66)');
  const base=await client.query("SELECT to_regclass('public.loyalty_claims') IS NOT NULL AND to_regclass('public.loyalty_claim_items') IS NOT NULL AND to_regclass('public.crm_counter_schema_migrations') IS NOT NULL AS ready");if(!base.rows[0].ready)throw Error('CENTRAL_LOYALTY_STORAGE_REQUIRED');
  const applied=await client.query('SELECT 1 FROM public.crm_counter_schema_migrations WHERE filename=$1',[filename]);
  const columns=await client.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='loyalty_claims' AND column_name=ANY($1::text[])",[['receipt_total_amount','receipt_snapshot']]);
  const alreadyApplied=applied.rowCount===1;
  if(alreadyApplied ? columns.rows[0].n!==2 : columns.rows[0].n!==0)throw Error('HISTORY_EXISTING_SCHEMA_REQUIRES_REVIEW');
  if(!alreadyApplied)await client.query(fs.readFileSync(path.join(__dirname,'../migrations',filename),'utf8'));
  const privacy=await client.query("SELECT count(*)::int AS n,bool_and(c.relrowsecurity) AS rls FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='public' AND c.relname=ANY($1::text[])",[['loyalty_claims','loyalty_claim_items']]);
  const indexes=await client.query("SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname='public' AND indexname=ANY($1::text[])",[['loyalty_claims_member_history_idx','loyalty_claim_items_claim_idx']]);
  if(privacy.rows[0].n!==2 || !privacy.rows[0].rls || indexes.rows[0].n!==2)throw Error('HISTORY_STORAGE_VERIFICATION_FAILED');
  await client.query(apply?'COMMIT':'ROLLBACK');return {status:apply?'applied':'dry-run-rolled-back',filename,alreadyApplied,columnsAdded:alreadyApplied?0:2,rowLevelSecurity:true,indexesVerified:2,historicalRowsRewritten:false,unrelatedMigrationsRun:false};
 }catch(e){await client.query('ROLLBACK');throw e;}
}
async function main(){
 if(process.argv.slice(2).some(a=>a!=='--apply'))throw Error('MODE_NOT_ALLOWED');
 const url=new URL(process.env.SC_OFFICIAL_SUPABASE_DATABASE_URL);for(const key of ['sslmode','sslcert','sslkey','sslrootcert'])if(url.searchParams.has(key))throw Error('TLS_OVERRIDE_REFUSED');
 const ca=process.env.CRM_BOOTSTRAP_TLS_CA_FILE;
 const db=new Client({connectionString:url.href,ssl:{rejectUnauthorized:true,...(ca?{ca:fs.readFileSync(ca,'utf8')}:{})},connectionTimeoutMillis:10000,query_timeout:20000});
 try{await db.connect();console.log(JSON.stringify(await provisionPurchaseHistory(db,{apply:process.argv.includes('--apply')})));}finally{await db.end();}
}
module.exports={provisionPurchaseHistory,filename};
if(require.main===module)main().catch(()=>{console.error('{"ok":false,"code":"HISTORY_PROVISION_FAILED","detailsWithheld":true}');process.exitCode=1;});
