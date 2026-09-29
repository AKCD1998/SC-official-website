const { Pool } = require('pg');
const { HEADERS, parseSalesSourceRows } = require('../src/modules/seamless/services/shopeeSalesSourceService');
const { importSalesSources } = require('../src/modules/seamless/db/shopeeSalesSourceRepository');
const { getTables } = require('../src/modules/seamless/tables');
const describePostgres = process.env.SEAMLESS_MIGRATION_SMOKE === '1' ? describe : describe.skip;

function localTestUrl() {
  const connection = process.env.SEAMLESS_MIGRATION_TEST_DATABASE_URL;
  if (!connection || !/_(test|ci)$/u.test(process.env.SEAMLESS_DB_SCHEMA || '')) throw new Error('Explicit ephemeral test schema required');
  const target = new URL(connection);
  if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) || !/_(test|ci)$/u.test(target.pathname)) throw new Error('Only local disposable PostgreSQL is allowed');
  return connection;
}

describePostgres('source product financial components in PostgreSQL', () => {
  let pool; let client;
  beforeAll(async () => {
    pool = new Pool({ connectionString: localTestUrl(), ssl: false });
    client = await pool.connect(); await client.query('BEGIN');
  });
  afterAll(async () => {
    if (client) { await client.query('ROLLBACK'); client.release(); }
    if (pool) await pool.end();
  });

  test('same-hash replay fills a missing component array once and refuses changed allocation or identity', async () => {
    const source = parseSalesSourceRows([Object.values(HEADERS), ...[
      { name: 'Synthetic spray', quantity: 1, unitPrice: 102, itemSubtotal: 102, shopeeProductDiscount: 1 },
      { name: 'Synthetic lozenge', quantity: 1, unitPrice: 19, itemSubtotal: 19, shopeeProductDiscount: 0 },
    ].map(values => Object.keys(HEADERS).map(key => ({ orderNumber: '200101SRCFIN01', status: 'สำเร็จแล้ว',
      orderedAt: '2020-01-01 12:00', paidAt: '2020-01-01 12:01', completedAt: '-', variant: '',
      voucherCodes: '-', sellerVoucher: 0, ...values })[key]))], {
      shopCode: 'sc-drug-store', sourceFilename: 'Order.all.20200101_20200101.xlsx',
      sourceSha256: '8'.repeat(64), observedAt: '2020-01-02T00:00:00Z',
    });
    const legacy = { ...source, facts: source.facts.map(({ lineFinancials, ...fact }) => fact) };
    const opts = { client, actor: 'synthetic-source-line-test', manageTransaction: false };
    const table = getTables().shopeeSalesOrderFacts;
    const read = async () => (await client.query(`SELECT * FROM ${table} WHERE source_sha256=$1`, [source.sourceSha256])).rows[0];
    await importSalesSources([legacy], opts);
    const before = await read(); expect(before.source_line_components).toBeNull();
    expect(await importSalesSources([source], opts)).toEqual({ imported: 0, unchanged: 1 });
    const after = await read();
    expect(after.source_line_components).toEqual(source.facts[0].lineFinancials);
    const { source_line_components: beforeComponents, ...beforeFacts } = before;
    const { source_line_components: afterComponents, ...afterFacts } = after;
    expect(afterFacts).toEqual(beforeFacts);
    await importSalesSources([source], opts);
    expect(await read()).toEqual(after);
    const changed = { ...source, facts: [{ ...source.facts[0], lineFinancials: [
      { netSale: 101, shopeeProductDiscount: 1 }, { netSale: 20, shopeeProductDiscount: 0 },
    ] }] };
    await expect(importSalesSources([changed], opts)).rejects.toThrow('immutable order lineage');
    expect(await read()).toEqual(after);
    await client.query(`UPDATE ${table} SET source_line_components=NULL WHERE source_sha256=$1`, [source.sourceSha256]);
    const wrongIdentity = { ...source, facts: [{ ...source.facts[0], items: [
      { ...source.facts[0].items[0], name: 'Other product' }, source.facts[0].items[1],
    ] }] };
    await expect(importSalesSources([wrongIdentity], opts)).rejects.toThrow('immutable order lineage');
    expect((await read()).source_line_components).toBeNull();
  });
});
