'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const filename = '20261101042429_crm_member_registrations.sql';
async function provisionMemberRegistrationReporting(client, { apply = false, activate = false } = {}) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout='1s'");
    await client.query("SET LOCAL statement_timeout='15s'");
    await client.query('SELECT pg_advisory_xact_lock(20261101,65)');
    const ready = await client.query("SELECT to_regclass('public.crm_counter_schema_migrations') IS NOT NULL AND to_regclass('public.member_profiles') IS NOT NULL AS ready");
    if (!ready.rows[0].ready) throw Error('CRM_BOOTSTRAP_REQUIRED');
    await client.query(fs.readFileSync(path.join(__dirname, '../migrations', filename), 'utf8'));
    await client.query(fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261103084446_crm_terminal_referrals.sql'), 'utf8'));
    const privacy = await client.query(`SELECT count(*)::int AS count, bool_and(c.relrowsecurity) AS rls
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='crm_reporting' AND c.relname IN ('member_registrations','registration_tracking') AND c.relkind='r'`);
    if (privacy.rows[0].count !== 2 || !privacy.rows[0].rls) throw Error('REPORTING_PRIVACY_CHECK_FAILED');
    if (activate) await client.query('UPDATE crm_reporting.registration_tracking SET tracking_started_at = now() WHERE id = 1 AND tracking_started_at IS NULL');
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    return { status: apply ? 'applied' : 'dry-run-rolled-back', filename, rowLevelSecurity: true,
      historicalMembersBackfilled: false, unrelatedMigrationsRun: false };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
async function main() {
  if (process.argv.slice(2).some(arg => !['--apply', '--activate'].includes(arg))) throw Error('UNSUPPORTED_MODE');
  const raw = process.env.SC_OFFICIAL_SUPABASE_DATABASE_URL;
  const url = new URL(raw || 'http://invalid');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !/\.(supabase\.co|supabase\.com)$/i.test(url.hostname)) throw Error('CRM_DATABASE_REQUIRED');
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) if (url.searchParams.has(key)) throw Error('TLS_OVERRIDE_REFUSED');
  const ca = process.env.CRM_BOOTSTRAP_TLS_CA_FILE;
  const client = new Client({ connectionString: raw, ssl: { rejectUnauthorized: true, ...(ca ? { ca: fs.readFileSync(ca, 'utf8') } : {}) }, connectionTimeoutMillis: 8000, query_timeout: 18000 });
  client.on('error', () => {});
  try { await client.connect(); console.log(JSON.stringify(await provisionMemberRegistrationReporting(client, { apply: process.argv.includes('--apply'), activate: process.argv.includes('--activate') }))); }
  finally { await client.end(); }
}
module.exports = { provisionMemberRegistrationReporting, filename };
if (require.main === module) main().catch(() => { console.error('{"status":"stopped","code":"MEMBER_REPORTING_PROVISION_FAILED","detailsWithheld":true}'); process.exitCode = 1; });
