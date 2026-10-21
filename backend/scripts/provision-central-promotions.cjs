'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const filename = '202610210001_central_promotions.sql';
const tables = ['promotions','point_ledger','loyalty_claims','loyalty_claim_items','crm_pos_sale_events','crm_pos_sale_line_events','crm_pos_refund_events','crm_pos_refund_line_events','crm_sale_claim_tokens','crm_sale_claims','crm_loyalty_awards','crm_loyalty_reversals','transactions','redemptions'];
async function provisionCentralPromotions(client, { apply = false } = {}) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query('SET LOCAL search_path = public');
    await client.query('SELECT pg_advisory_xact_lock(20261021, 65)');
    const base = await client.query("SELECT to_regclass('public.users') IS NOT NULL AND to_regclass('public.member_profiles') IS NOT NULL AND to_regclass('public.crm_counter_schema_migrations') IS NOT NULL AS ready");
    if (!base.rows[0].ready) throw Error('CRM_BOOTSTRAP_REQUIRED');
    const existing = await client.query("SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])",[tables]);
    const applied = await client.query('SELECT 1 FROM public.crm_counter_schema_migrations WHERE filename=$1',[filename]);
    const alreadyApplied = applied.rowCount === 1;
    if (existing.rows[0].count !== 0 && !(alreadyApplied && existing.rows[0].count === tables.length)) throw Error('PROMOTION_EXISTING_SCHEMA_REQUIRES_REVIEW');
    if (!alreadyApplied) await client.query(fs.readFileSync(path.join(__dirname,'../migrations',filename),'utf8'));
    const privacy = await client.query("SELECT count(*)::int AS count, bool_and(c.relrowsecurity) AS rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND c.relkind='r'",[tables]);
    if (privacy.rows[0].count !== tables.length || !privacy.rows[0].rls) throw Error('PROMOTION_PRIVACY_FAILED');
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    return {status:apply?'applied':'dry-run-rolled-back',filename,alreadyApplied,tablesVerified:tables.length,rowLevelSecurity:true,businessRowsInserted:false,unrelatedMigrationsRun:false};
  } catch(error) { await client.query('ROLLBACK');throw error; }
}
async function main() {
  if(process.argv.slice(2).some(a=>a!=='--apply'))throw Error('MODE_NOT_ALLOWED');
  const raw=process.env.SC_OFFICIAL_SUPABASE_DATABASE_URL;if(!raw)throw Error('DATABASE_REQUIRED');
  const url=new URL(raw);if(!['postgres:','postgresql:'].includes(url.protocol))throw Error('PROTOCOL_REFUSED');
  for(const key of ['sslmode','sslcert','sslkey','sslrootcert'])if(url.searchParams.has(key))throw Error('TLS_OVERRIDE_REFUSED');
  const ca=process.env.CRM_BOOTSTRAP_TLS_CA_FILE;
  const db=new Client({connectionString:raw,ssl:{rejectUnauthorized:true,...(ca?{ca:fs.readFileSync(ca,'utf8')}:{})},connectionTimeoutMillis:10000,query_timeout:20000});
  db.on('error',()=>{});try{await db.connect();console.log(JSON.stringify(await provisionCentralPromotions(db,{apply:process.argv.includes('--apply')})));}finally{await db.end();}
}
module.exports={provisionCentralPromotions,tables,filename};
if(require.main===module)main().catch(()=>{console.error('{"status":"stopped","code":"PROMOTION_PROVISION_FAILED","detailsWithheld":true}');process.exitCode=1;});
