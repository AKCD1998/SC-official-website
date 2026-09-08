// Integration verifier: an isolated LOCAL PostgreSQL schema, original workbooks,
// and a previously captured read-only email-order snapshot. No network services,
// sync, printing, notification, or production database access are permitted.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const ExcelJS = require('exceljs');
const { HEADERS, parseSalesSourceRows, readSalesSource } = require('../src/modules/seamless/services/shopeeSalesSourceService');
const { importSalesSources } = require('../src/modules/seamless/db/shopeeSalesSourceRepository');
const { HEADERS: CONFIRMED_HEADERS, readConfirmedSalesSource, parseConfirmedSalesRows, getConfirmedSalesSummary } = require('../src/modules/seamless/services/shopeeConfirmedSalesService');
const { importConfirmedSalesSources } = require('../src/modules/seamless/db/shopeeConfirmedSalesRepository');

function assertLocalDatabaseUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('A valid LOCAL PostgreSQL URL is required.'); }
  const allowed = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.search || parsed.hash
    || !allowed.has(parsed.hostname)) throw new Error('LOCAL database without URL query overrides is required.');
  // pg connection strings may otherwise override authority fields via ?host=.
  // Inspect the driver's resolved destination without making a connection.
  const probe = new Client({ connectionString: url });
  if (!allowed.has(probe.connectionParameters.host)) throw new Error('Resolved PostgreSQL host must be LOCAL.');
}

async function verifySyntheticInvariants({ client, url, getShopeeSalesSummary, baseSchema }) {
  const schema = `${baseSchema.slice(0, -3)}_fixtures_ci`;
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  await client.query(`CREATE TABLE shopee_orders (LIKE "${baseSchema}".shopee_orders INCLUDING ALL)`);
  await client.query(await fs.readFile(path.join(__dirname, '../src/modules/seamless/db/migrations/016_shopee_sales_sources.sql'), 'utf8'));
  await client.query(await fs.readFile(path.join(__dirname, '../src/modules/seamless/db/migrations/017_shopee_confirmed_sales.sql'), 'utf8'));
  process.env.SEAMLESS_DB_SCHEMA = schema;
  let sequence = 0;
  function makeSource(shopCode, amount, observedAt, overrides = {}) {
    const data = { orderNumber: 'SHAREDTEST01', status: 'สำเร็จแล้ว', orderedAt: '2026-08-08 07:00',
      name: 'สินค้าทดสอบ', variant: 'หนึ่งกล่อง', quantity: 1, unitPrice: amount, itemSubtotal: amount,
      sellerVoucher: 0, shopeeProductDiscount: 0, ...overrides };
    const sourceSha256 = crypto.createHash('sha256').update(`synthetic-${++sequence}`).digest('hex');
    return parseSalesSourceRows([Object.values(HEADERS), Object.keys(HEADERS).map((key) => data[key])], {
      shopCode, sourceFilename: 'Order.all.20260803_20260809.xlsx', sourceSha256, observedAt,
    });
  }
  const query = (shopCode = 'all') => getShopeeSalesSummary({ shopCode, startDate: '2026-08-08', endDate: '2026-08-08' });
  const apply = (sources) => importSalesSources(sources, { client, actor: 'local-synthetic-test' });
  await apply([makeSource('sc-drug-store', 100, '2026-09-05T00:00:00Z')]);
  assert.equal((await query()).accounting.calculatedSalesTotal, 100, 'FULL OUTER JOIN must include raw-only orders.');
  await apply([makeSource('sc-drug-store', 50, '2026-09-04T00:00:00Z')]);
  assert.equal((await query()).accounting.calculatedSalesTotal, 100, 'Older import cannot supersede newer evidence.');
  await apply([makeSource('dr-morepen', 70, '2026-09-05T00:00:00Z')]);
  assert.equal((await query()).orderCount, 2, 'Same ID in two shops must remain distinct.');
  assert.equal((await query()).accounting.calculatedSalesTotal, 170);
  await apply([makeSource('sc-drug-store', 100, '2026-09-06T00:00:00Z', { status: 'ยกเลิกแล้ว' })]);
  assert.equal((await query('sc-drug-store')).orderCount, 0, 'Latest raw cancellation must exclude the order.');
  await client.query(`INSERT INTO shopee_orders (shop_code,order_number,current_status,ordered_at,items)
    VALUES ('sc-drug-store','SHAREDTEST01','shipment_due','2026-08-08T00:00:00Z','[{"name":"สินค้า","quantity":1}]'),
           ('dr-morepen','SHAREDTEST01','order_cancelled','2026-08-08T00:00:00Z','[{"name":"สินค้า","quantity":1}]')`);
  assert.equal((await query()).orderCount, 0, 'Raw cancellation and terminal email state cannot be resurrected.');
  await assert.rejects(apply([makeSource('sc-drug-store', 200, '2026-09-06T00:00:00Z')]), /Ambiguous/);
  const times = ['2026-08-07 23:59:59', '2026-08-08 00:00:00', '2026-08-08 23:59:59', '2026-08-09 00:00:00'];
  for (let i = 0; i < times.length; i += 1) {
    await apply([makeSource('sc-drug-store', 10, '2026-09-05T00:00:00Z', { orderNumber: `BOUNDARY0${i}`, orderedAt: times[i] })]);
  }
  assert.equal((await query()).orderCount, 2, 'Thai start inclusive and next midnight exclusive.');
  assert.equal((await query()).accounting.calculatedSalesTotal, 20);
  const beforeSources = Number((await client.query('SELECT count(*) FROM shopee_sales_sources')).rows[0].count);
  const valid = makeSource('sc-drug-store', 10, '2026-09-05T00:00:00Z', { orderNumber: 'ROLLBACK01' });
  const bad = makeSource('sc-drug-store', 10, '2026-09-05T00:00:00Z', { orderNumber: 'ROLLBACK02' });
  bad.facts[0].itemSubtotal = -1;
  await assert.rejects(apply([valid, bad]));
  assert.equal(Number((await client.query('SELECT count(*) FROM shopee_sales_sources')).rows[0].count), beforeSources,
    'A bad second file must roll back the first file too.');
  const scSource = makeSource('sc-drug-store', 20, '2026-09-05T00:00:00Z', { orderNumber: 'CONCURRENT1' });
  const drSource = { ...scSource, shopCode: 'dr-morepen', facts: scSource.facts.map((fact) => ({ ...fact, shopCode: 'dr-morepen' })) };
  const otherClient = new Client({ connectionString: url }); await otherClient.connect();
  try {
    const outcomes = await Promise.allSettled([
      apply([scSource]), importSalesSources([drSource], { client: otherClient, actor: 'local-race-test' }),
    ]);
    assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(Number((await client.query('SELECT count(*) FROM shopee_sales_sources WHERE source_sha256=$1', [scSource.sourceSha256])).rows[0].count), 1);
  } finally { await otherClient.end(); }
  function confirmedSource(shopCode, day, amount, observedAt) {
    const username = shopCode === 'sc-drug-store' ? '142wuxqhgi' : 'mu3f314od9';
    const date = `0${day}-08-2026`;
    const metrics = [amount, amount ? 1 : 0, 0, 0, 0, 0];
    return parseConfirmedSalesRows([Object.values(CONFIRMED_HEADERS), [`${date}-${date}`, ...metrics], [],
      Object.values(CONFIRMED_HEADERS), [date, ...metrics]], { shopCode, observedAt,
      sourceFilename: `${username}.shopee-shop-stats.2026080${day}-2026080${day}.xlsx`,
      sourceSha256: crypto.createHash('sha256').update(`confirmed-${++sequence}`).digest('hex') });
  }
  const confirmedFilters = { shopCode: 'sc-drug-store', startDate: '2026-08-01', endDate: '2026-08-02' };
  const applyConfirmed = sources => importConfirmedSalesSources(sources, { client, actor: 'local-confirmed-test' });
  const first = confirmedSource('sc-drug-store', 1, 100, '2026-09-05T00:00:00Z');
  await applyConfirmed([first]);
  assert.deepEqual(await applyConfirmed([first]), { imported: 0, unchanged: 1 });
  assert.equal((await getConfirmedSalesSummary(confirmedFilters)).salesTotal, null, 'Missing official zero/nonzero day cannot become a partial headline.');
  await applyConfirmed([confirmedSource('sc-drug-store', 2, 0, '2026-09-05T00:00:00Z')]);
  assert.equal((await getConfirmedSalesSummary(confirmedFilters)).salesTotal, 100, 'Explicit zero day completes source coverage.');
  await applyConfirmed([confirmedSource('sc-drug-store', 1, 50, '2026-09-04T00:00:00Z')]);
  assert.equal((await getConfirmedSalesSummary(confirmedFilters)).salesTotal, 100, 'Older confirmed source cannot replace latest.');
  await applyConfirmed([confirmedSource('sc-drug-store', 1, 125.25, '2026-09-06T00:00:00Z')]);
  assert.equal((await getConfirmedSalesSummary(confirmedFilters)).salesTotal, 125.25, 'Newer confirmed day replaces once, without double count.');
  assert.equal((await getConfirmedSalesSummary({ ...confirmedFilters, startDate: '2026-08-02' })).salesTotal, 0);
  await assert.rejects(applyConfirmed([confirmedSource('sc-drug-store', 1, 130, '2026-09-06T00:00:00Z')]), /Ambiguous/);
  await assert.rejects(applyConfirmed([{ ...first, observedAt: '2026-09-07T00:00:00.000Z' }]), /metadata/);
  const incompleteAll = await getConfirmedSalesSummary({ ...confirmedFilters, shopCode: 'all' });
  assert.equal(incompleteAll.salesTotal, null, 'Missing other shop cannot become a combined total.');
  assert.equal(incompleteAll.shops[0].salesTotal, 125.25);
  const beforeConfirmed = Number((await client.query('SELECT count(*) FROM shopee_confirmed_sources')).rows[0].count);
  const goodConfirmed = confirmedSource('dr-morepen', 1, 10, '2026-09-05T00:00:00Z');
  const badConfirmed = confirmedSource('dr-morepen', 2, 10, '2026-09-05T00:00:00Z');
  badConfirmed.facts[0].salesTotal = -1;
  await assert.rejects(applyConfirmed([goodConfirmed, badConfirmed]));
  assert.equal(Number((await client.query('SELECT count(*) FROM shopee_confirmed_sources')).rows[0].count), beforeConfirmed);
  process.env.SEAMLESS_DB_SCHEMA = baseSchema;
  await client.query(`SET search_path TO "${baseSchema}"`);
  return { schema, rawOnlyOrders: true, olderSnapshots: true, crossShopIds: true, cancellations: true,
    ambiguousSnapshotsRejected: true, bangkokBoundaries: true, atomicRollback: true, concurrentHashIsolation: true,
    confirmed: { coverageAndZeroDays: true, latestDayPrecedence: true, dateSubsets: true, ambiguousRejected: true,
      immutableMetadata: true, crossShopCoverage: true, idempotency: true, atomicRollback: true } };
}

async function main() {
  const url = process.env.SHOPEE_SALES_VERIFY_DATABASE_URL || '';
  assertLocalDatabaseUrl(url);
  const input = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  const schema = `shopee_sales_${crypto.randomBytes(6).toString('hex')}_ci`;
  // Process-local variables only, set before any app DB singleton is required.
  process.env.SC_OFFICIAL_SUPABASE_DATABASE_URL = url;
  process.env.SEAMLESS_DB_SCHEMA = schema;
  const client = new Client({ connectionString: url });
  await client.connect();
  let pool;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`CREATE TABLE shopee_orders (
      shop_code text, order_number text, current_status text, ordered_at timestamptz,
      shipping_deadline date, items jsonb, item_count integer, total_quantity integer,
      item_subtotal numeric(14,2), shipping_fee numeric(14,2), total_amount numeric(14,2),
      first_event_at timestamptz, last_event_at timestamptz, PRIMARY KEY (shop_code, order_number)
    )`);
    await client.query(await fs.readFile(path.join(__dirname, '../src/modules/seamless/db/migrations/016_shopee_sales_sources.sql'), 'utf8'));
    // Migration must also be repeatable without disturbing evidence.
    await client.query(await fs.readFile(path.join(__dirname, '../src/modules/seamless/db/migrations/016_shopee_sales_sources.sql'), 'utf8'));
    await client.query(await fs.readFile(path.join(__dirname, '../src/modules/seamless/db/migrations/017_shopee_confirmed_sales.sql'), 'utf8'));
    await client.query(await fs.readFile(path.join(__dirname, '../src/modules/seamless/db/migrations/017_shopee_confirmed_sales.sql'), 'utf8'));
    const snapshot = JSON.parse(await fs.readFile(input.emailSnapshot, 'utf8'));
    const columns = ['shop_code', 'order_number', 'current_status', 'ordered_at', 'shipping_deadline', 'items', 'item_count',
      'total_quantity', 'item_subtotal', 'shipping_fee', 'total_amount', 'first_event_at', 'last_event_at'];
    for (const row of snapshot) {
      await client.query(`INSERT INTO shopee_orders (${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`,
        columns.map((key) => key === 'items' ? JSON.stringify(row[key]) : row[key]));
    }
    const before = (await client.query('SELECT * FROM shopee_orders ORDER BY shop_code,order_number')).rows;
    const { getShopeeSalesSummary } = require('../src/modules/seamless/services/shopeeSalesSummaryService');
    const { exportShopeeSalesSummary } = require('../src/modules/seamless/services/shopeeSalesSummaryExportService');
    pool = require('../db');
    const results = [];
    for (const shop of input.shops) {
      const filters = { shopCode: shop.code, startDate: input.startDate, endDate: input.endDate, includeConfirmed: true };
      const beforeSummary = await getShopeeSalesSummary(filters);
      assert.equal(beforeSummary.confirmedSales.salesTotal, null, 'No official source must mean unavailable primary.');
      const confirmedSource = await readConfirmedSalesSource(shop.statisticsFile, { shopCode: shop.code, observedAt: input.observedAt });
      assert.deepEqual(await importConfirmedSalesSources([confirmedSource], { client, actor: 'local-integration-verifier' }), { imported: 1, unchanged: 0 });
      assert.deepEqual(await importConfirmedSalesSources([confirmedSource], { client, actor: 'local-integration-verifier' }), { imported: 0, unchanged: 1 });
      const filenames = (await fs.readdir(shop.ordersDirectory)).filter((name) => /^Order\.all\..*\.xlsx$/iu.test(name));
      const sources = await Promise.all(filenames.map((name) => readSalesSource(path.join(shop.ordersDirectory, name), {
        shopCode: shop.code, observedAt: input.observedAt,
      })));
      const imported = await importSalesSources(sources, { client, actor: 'local-integration-verifier' });
      assert.equal(imported.imported, sources.length);
      assert.deepEqual(await importSalesSources(sources, { client, actor: 'local-integration-verifier' }), { imported: 0, unchanged: sources.length });
      const summary = await getShopeeSalesSummary(filters);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(shop.statisticsFile);
      const sheet = workbook.getWorksheet('ทั้งหมด');
      const amount = (cell) => Number(String(cell.value).replace(/,/gu, ''));
      const expectedAmount = amount(sheet.getCell('B2')) - amount(sheet.getCell('J2'));
      const expectedCount = amount(sheet.getCell('D2')) - amount(sheet.getCell('I2'));
      const confirmedSheet = workbook.getWorksheet('ยืนยันแล้ว');
      assert.equal(summary.confirmedSales.salesTotal, amount(confirmedSheet.getCell('B2')));
      assert.equal(summary.confirmedSales.orderCount, amount(confirmedSheet.getCell('D2')));
      assert.equal(summary.confirmedSales.cancelledSales, amount(confirmedSheet.getCell('J2')));
      assert.equal(summary.confirmedSales.cancelledOrderCount, amount(confirmedSheet.getCell('I2')));
      assert.equal(summary.confirmedSales.status, 'source_backed');
      assert.equal(summary.confirmedSales.daily.length, 31);
      for (let row = 5; row <= 35; row += 1) {
        const date = String(confirmedSheet.getCell(`A${row}`).value).split('-').reverse().join('-');
        const actual = summary.confirmedSales.daily.find(day => day.date === date);
        assert.ok(actual, 'All confirmed dates including zero days must be persisted.');
        for (const [key, column] of Object.entries({ salesTotal: 'B', orderCount: 'D', cancelledOrderCount: 'I', cancelledSales: 'J', returnedOrderCount: 'K', returnedSales: 'L' })) {
          assert.equal(actual[key], amount(confirmedSheet.getCell(`${column}${row}`)), `${shop.code} confirmed ${date} ${key}`);
        }
      }
      assert.equal(summary.orderCount, expectedCount);
      assert.equal(summary.accounting.orders.length, expectedCount);
      assert.equal(summary.accounting.calculatedSalesTotal, expectedAmount);
      assert.equal(summary.accounting.sourceBackedSalesTotal, null);
      assert.equal(summary.accounting.status, 'provisional');
      const daily = new Map();
      for (const order of summary.accounting.orders) {
        const date = new Date(new Date(order.orderedAt).getTime() + 7 * 3600000).toISOString().slice(0, 10);
        const item = daily.get(date) || { cents: 0, count: 0 };
        item.cents += Math.round(order.salesAmount * 100); item.count += 1; daily.set(date, item);
      }
      let checkedDays = 0;
      for (let row = 5; row <= sheet.rowCount; row += 1) {
        const rawDate = String(sheet.getCell(`A${row}`).value || '');
        const date = rawDate.split('-').reverse().join('-');
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) continue;
        const actual = daily.get(date) || { cents: 0, count: 0 };
        const expectedDailyCents = Math.round(amount(sheet.getCell(`B${row}`)) * 100)
          - Math.round(amount(sheet.getCell(`J${row}`)) * 100);
        assert.equal(actual.cents, expectedDailyCents, `Daily money: ${shop.code} ${date}`);
        assert.equal(actual.count, amount(sheet.getCell(`D${row}`)) - amount(sheet.getCell(`I${row}`)), `Daily orders: ${shop.code} ${date}`);
        checkedDays += 1;
      }
      assert.equal(checkedDays, 31);
      const exported = await exportShopeeSalesSummary({ ...filters, includeAccounting: true });
      const reopened = new ExcelJS.Workbook(); await reopened.xlsx.load(exported.buffer);
      assert.equal(reopened.worksheets[0].name, 'ยอดขายยืนยันแล้ว');
      assert.equal(reopened.worksheets[0].getCell('C2').value, summary.confirmedSales.salesTotal);
      assert.equal(reopened.worksheets[0].getCell('D2').value, summary.confirmedSales.orderCount);
      const ledger = reopened.getWorksheet('ยอดขายรายออเดอร์');
      assert.equal(ledger.rowCount - 1, expectedCount);
      let exportCents = 0;
      ledger.eachRow((row, n) => { if (n > 1) exportCents += Math.round(row.getCell(7).value * 100); });
      assert.equal(exportCents, Math.round(expectedAmount * 100));
      assert.equal(reopened.getWorksheet('พร้อมคีย์').columnCount, 7);
      for (const worksheet of reopened.worksheets) {
        assert.equal(worksheet.pageSetup.orientation, 'landscape');
        assert.equal(worksheet.pageSetup.fitToWidth, 1);
      }
      const userExport = await exportShopeeSalesSummary(filters);
      const userWorkbook = new ExcelJS.Workbook(); await userWorkbook.xlsx.load(userExport.buffer);
      assert.equal(userWorkbook.getWorksheet('ยอดขายรายออเดอร์'), undefined);
      assert.equal(userWorkbook.getWorksheet('ยอดขายยืนยันแล้ว'), undefined);
      results.push({ shopCode: shop.code, beforeCount: beforeSummary.orderCount,
        beforeAmount: beforeSummary.accounting.calculatedSalesTotal,
        primaryConfirmedSales: summary.confirmedSales.salesTotal, primaryConfirmedOrders: summary.confirmedSales.orderCount,
        confirmedCancelledSales: summary.confirmedSales.cancelledSales, confirmedSourceSha256: confirmedSource.sourceSha256,
        confirmedDailyChecks: 31, confirmedStatus: summary.confirmedSales.status,
        orderCount: summary.orderCount, salesTotal: summary.accounting.calculatedSalesTotal,
        sourceBackedOrders: summary.accounting.sourceBackedOrderCount,
        provisionalOrders: summary.accounting.provisionalOrderCount,
        quantityReviewOrders: summary.accounting.quantityReviewOrderCount,
        checkedDays, dailyResiduals: 0, readyRows: exported.readyRowCount, reviewRows: exported.reviewRowCount,
        files: sources.map((source) => ({ name: source.sourceFilename, sha256: source.sourceSha256 })) });
      console.log(JSON.stringify(results.at(-1)));
    }
    const after = (await client.query('SELECT * FROM shopee_orders ORDER BY shop_code,order_number')).rows;
    assert.deepEqual(after, before, 'Email-derived order history must be unchanged.');
    const combined = await getShopeeSalesSummary({ shopCode: 'all', startDate: input.startDate, endDate: input.endDate, includeConfirmed: true });
    assert.equal(combined.orderCount, results.reduce((n, row) => n + row.orderCount, 0));
    assert.equal(combined.accounting.calculatedSalesTotal, results.reduce((n, row) => n + row.salesTotal, 0));
    assert.equal(combined.confirmedSales.salesTotal, results.reduce((n, row) => n + row.primaryConfirmedSales, 0));
    assert.equal(combined.confirmedSales.orderCount, results.reduce((n, row) => n + row.primaryConfirmedOrders, 0));
    const invariants = await verifySyntheticInvariants({ client, url, getShopeeSalesSummary, baseSchema: schema });
    const output = { schema, databaseScope: 'local_only', originalEmailHistoryUnchanged: true, invariants, results };
    console.log(JSON.stringify({ localPostgresInvariants: invariants }));
    if (input.output) await fs.writeFile(input.output, JSON.stringify(output, null, 2));
    return output;
  } finally {
    if (pool) await pool.end();
    await client.end();
  }
}
if (require.main === module) main().catch((error) => {
  console.error(`Local sales verification failed (${error.code || 'VALIDATION_ERROR'}).`);
  process.exitCode = 1;
});
module.exports = { assertLocalDatabaseUrl, main };
