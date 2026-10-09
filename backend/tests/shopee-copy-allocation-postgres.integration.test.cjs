jest.mock('../db', () => ({ query: jest.fn() }));
const db = require('../db');
const { Pool } = require('pg');
const { HEADERS, parseSalesSourceRows } = require('../src/modules/seamless/services/shopeeSalesSourceService');
const { importSalesSources } = require('../src/modules/seamless/db/shopeeSalesSourceRepository');
const { getOrdersForCopyCohort } = require('../src/modules/seamless/db/shopeeAdaSmartCopyRepository');
const { getTables } = require('../src/modules/seamless/tables');
const describePostgres = process.env.SEAMLESS_MIGRATION_SMOKE === '1' ? describe : describe.skip;

describePostgres('private copy policy and original evidence in PostgreSQL', () => {
  let pool; let client;
  beforeAll(async () => {
    const target = new URL(process.env.SEAMLESS_MIGRATION_TEST_DATABASE_URL);
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) || !/_(test|ci)$/u.test(target.pathname)
      || !/_(test|ci)$/u.test(process.env.SEAMLESS_DB_SCHEMA || '')) throw new Error('Only explicit disposable local PostgreSQL is allowed');
    pool = new Pool({ connectionString: target.href, ssl: false });
    client = await pool.connect(); await client.query('BEGIN');
    db.query.mockImplementation((...args) => client.query(...args));
  });
  afterAll(async () => {
    if (client) { await client.query('ROLLBACK'); client.release(); }
    if (pool) await pool.end();
  });
  test('repository reads policies, voucher codes and all snapshots consistently without changing source facts', async () => {
    const source = parseSalesSourceRows([Object.values(HEADERS), ...['First', 'Second'].map(name => Object.keys(HEADERS)
      .map(key => ({ orderNumber: '200101POLICY01', status: 'สำเร็จแล้ว', orderedAt: '2020-01-01 12:00',
        paidAt: '2020-01-01 12:01', completedAt: '-', variant: '', voucherCodes: 'SYNTHETIC-CODE',
        sellerVoucher: 10, name, quantity: 1, unitPrice: 174, itemSubtotal: 174, shopeeProductDiscount: 0 })[key]))],
    { shopCode: 'sc-drug-store', sourceFilename: 'Order.all.20200101_20200101.xlsx',
      sourceSha256: '9'.repeat(64), observedAt: '2020-01-02T00:00:00Z' });
    await importSalesSources([source], { client, actor: 'synthetic-test', manageTransaction: false });
    const tables = getTables();
    const before = (await client.query(`SELECT * FROM ${tables.shopeeSalesOrderFacts} WHERE source_sha256=$1`, [source.sourceSha256])).rows;
    await client.query(`INSERT INTO ${tables.shopeeCopyAllocationPolicies}
      (shop_code,policy_key,policy,approval,approved_by,approved_at) VALUES ($1,$2,$3,$4,$5,$6)`, [
      'sc-drug-store', 'synthetic', { type: 'seller_voucher', method: 'proportional_net_merchandise_largest_remainder' },
      { kind: 'user_confirmed_allocation', caseId: 'synthetic', responseSha256: 'a'.repeat(64) }, 'synthetic', '2020-01-02T00:00:00Z',
    ]);
    const filters = { shopCode: 'sc-drug-store', startDate: '2020-01-01', endDate: '2020-01-01' };
    const result = await getOrdersForCopyCohort(filters);
    expect(result.orders[0].voucherCodes).toEqual(['SYNTHETIC-CODE']);
    // An active order with an explicit voucher never enters cancellation
    // restoration. Its authoritative source remains in result.orders.
    expect(result.orderSnapshots).toEqual([]);
    expect(result.allocationPolicies).toHaveLength(1);
    expect(result.allocationPolicies[0]).toMatchObject({ policyKey: 'synthetic', enabled: true, approvedBy: 'synthetic' });
    await client.query(`UPDATE ${tables.shopeeCopyAllocationPolicies} SET enabled=false WHERE policy_key='synthetic'`);
    expect((await getOrdersForCopyCohort(filters)).allocationPolicies).toEqual([]);
    expect((await client.query(`SELECT * FROM ${tables.shopeeSalesOrderFacts} WHERE source_sha256=$1`, [source.sourceSha256])).rows).toEqual(before);
    await client.query('SAVEPOINT incomplete_approval');
    await expect(client.query(`INSERT INTO ${tables.shopeeCopyAllocationPolicies}
      (shop_code,policy_key,policy,approval,approved_by,approved_at) VALUES ('sc-drug-store','incomplete','{}','{}','synthetic',now())`))
      .rejects.toMatchObject({ code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT incomplete_approval');
  });
  test('month copy retains every restoration snapshot only for cancelled latest orders with zero seller voucher', async () => {
    const identities = ['200103CANCEL01', '200103ACTIVE01', '200103CANCEL02'];
    const source = (newest) => parseSalesSourceRows([Object.values(HEADERS), ...identities.map((id, index) =>
      Object.keys(HEADERS).map(key => ({ orderNumber: id,
        status: newest && index !== 1 ? 'ยกเลิกแล้ว' : 'สำเร็จแล้ว',
        orderedAt: '2020-01-03 12:00', paidAt: '2020-01-03 12:01', completedAt: '-',
        variant: '', voucherCodes: 'SYNTHETIC-CODE', name: 'Synthetic product', quantity: 1,
        unitPrice: 100, itemSubtotal: 100, shopeeProductDiscount: 0,
        sellerVoucher: index === 0 ? (newest ? 0 : 5) : index === 1 ? 0 : 2 })[key]))], {
      shopCode: 'sc-drug-store', sourceFilename: 'Order.all.20200103_20200103.xlsx',
      sourceSha256: (newest ? 'e' : 'd').repeat(64),
      observedAt: newest ? '2020-01-05T00:00:00Z' : '2020-01-04T00:00:00Z',
    });
    await importSalesSources([source(false), source(true)], { client, actor: 'synthetic-history-test', manageTransaction: false });
    const tables = getTables();
    const before = (await client.query(`SELECT * FROM ${tables.shopeeSalesOrderFacts}
      WHERE order_number=ANY($1::text[]) ORDER BY order_number,source_sha256`, [identities])).rows;
    const result = await getOrdersForCopyCohort({ shopCode: 'sc-drug-store', startDate: '2020-01-01', endDate: '2020-01-31' });
    expect(result.orders.filter(order => identities.includes(order.orderNumber))).toHaveLength(3);
    expect(result.orderSnapshots.map(order => order.orderNumber)).toEqual(['200103CANCEL01', '200103CANCEL01']);
    expect(result.orderSnapshots.map(order => order.sourceSha256)).toEqual(['d'.repeat(64), 'e'.repeat(64)]);
    expect(result.orderSnapshots.map(order => Number(order.sellerVoucher))).toEqual([5, 0]);
    expect(result.orderSnapshots.map(order => order.excluded)).toEqual([false, true]);
    expect((await client.query(`SELECT * FROM ${tables.shopeeSalesOrderFacts}
      WHERE order_number=ANY($1::text[]) ORDER BY order_number,source_sha256`, [identities])).rows).toEqual(before);
  });
});
