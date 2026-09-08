// Default: validate original exports and print a reviewable plan; NO DB connection.
const crypto = require('node:crypto');
const { readSalesSource } = require('../src/modules/seamless/services/shopeeSalesSourceService');
const { readConfirmedSalesSource } = require('../src/modules/seamless/services/shopeeConfirmedSalesService');

function parseArgs(args) {
  const options = { files: [], apply: false, type: 'orders' };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--apply') { options.apply = true; continue; }
    if (arg === '--type') {
      if (!['orders', 'confirmed'].includes(args[i + 1])) throw new Error('--type must be orders or confirmed.');
      options.type = args[++i]; continue;
    }
    const keys = { '--shop-code': 'shopCode', '--observed-at': 'observedAt', '--actor': 'actor',
      '--confirm-shop': 'confirmShop', '--plan-sha256': 'planSha256' };
    if (arg === '--file') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--file requires a path.');
      options.files.push(args[++i]);
    } else if (keys[arg]) {
      if (!args[i + 1] || args[i + 1].startsWith('--') || options[keys[arg]]) throw new Error(`Invalid ${arg}.`);
      options[keys[arg]] = args[++i];
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.files.length) throw new Error('Provide at least one --file.');
  return options;
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const reader = options.type === 'confirmed' ? readConfirmedSalesSource : readSalesSource;
  const sources = await Promise.all(options.files.map((file) => reader(file, options)));
  sources.sort((a, b) => a.sourceSha256.localeCompare(b.sourceSha256));
  if (new Set(sources.map((source) => source.sourceSha256)).size !== sources.length) {
    throw new Error('Duplicate source files in the plan.');
  }
  const planSha256 = crypto.createHash('sha256').update(JSON.stringify(sources)).digest('hex');
  const plan = { mode: options.apply ? 'apply' : 'dry_run', type: options.type, shopCode: options.shopCode, planSha256,
    files: sources.map(({ facts, ...source }) => ({ ...source, ...(options.type === 'confirmed'
      ? { dayCount: facts.length } : { orderCount: facts.length, excludedCount: facts.filter((fact) => fact.excluded).length }) })) };
  if (!options.apply) { console.log(JSON.stringify(plan)); return plan; }
  if (options.confirmShop !== options.shopCode || options.planSha256 !== planSha256 || !options.actor) {
    throw new Error('Apply requires --confirm-shop, the reviewed --plan-sha256, and --actor.');
  }
  // Never load .env or fall back to a shared production database implicitly.
  const connectionString = process.env.SHOPEE_SALES_IMPORT_DATABASE_URL;
  if (!connectionString) throw new Error('Set SHOPEE_SALES_IMPORT_DATABASE_URL explicitly for an approved import.');
  const { Client } = require('pg');
  const { importSalesSources } = require('../src/modules/seamless/db/shopeeSalesSourceRepository');
  const { importConfirmedSalesSources } = require('../src/modules/seamless/db/shopeeConfirmedSalesRepository');
  const client = new Client({ connectionString, options: '-c statement_timeout=30000 -c lock_timeout=10000' });
  try {
    await client.connect();
    const importer = options.type === 'confirmed' ? importConfirmedSalesSources : importSalesSources;
    const result = await importer(sources, { client, actor: options.actor });
    console.log(JSON.stringify({ ...plan, ...result }));
    return result;
  } finally { await client.end(); }
}

if (require.main === module) main().catch((error) => {
  // Database driver messages may contain connection/user details. Do not echo them.
  console.error(error.code ? `Import failed (database code ${error.code}).` : error.message);
  process.exitCode = 1;
});
module.exports = { main, parseArgs };
