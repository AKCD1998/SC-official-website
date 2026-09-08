const { moneyCents, resolveSalesOrders, summarizeSalesAccounting } = require('../src/modules/seamless/services/shopeeSalesAccounting');
const { HEADERS, classifyStatus, parseSalesSourceRows } = require('../src/modules/seamless/services/shopeeSalesSourceService');
const { parseArgs } = require('../scripts/import-shopee-sales-sources.cjs');
const { importSalesSources } = require('../src/modules/seamless/db/shopeeSalesSourceRepository');
const { assertLocalDatabaseUrl } = require('../scripts/verify-shopee-sales-local.cjs');

const base = { shopCode: 'sc-drug-store', orderNumber: '260808TEST01', currentStatus: 'shipment_due',
  orderedAt: '2026-08-08T00:00:00.000Z', itemSubtotal: 100,
  items: [{ name: 'สินค้า', quantity: 1 }, { name: 'สินค้าอื่น', quantity: 2 }] };
const source = { itemSubtotal: 100, sellerVoucher: 10, shopeeProductDiscount: 5, excluded: false,
  sourceFilename: 'Order.all.20260803_20260809.xlsx', sourceSha256: 'a'.repeat(64), observedAt: '2026-09-05T00:00:00.000Z' };
const options = { shopCode: 'sc-drug-store', sourceFilename: source.sourceFilename,
  sourceSha256: source.sourceSha256, observedAt: source.observedAt };
function rawRow(overrides = {}) {
  const data = { orderNumber: base.orderNumber, status: 'สำเร็จแล้ว', orderedAt: '2026-08-08 07:00',
    name: 'สินค้า', variant: 'หนึ่งกล่อง', quantity: 1, unitPrice: 50, itemSubtotal: 50,
    shopeeProductDiscount: 2, sellerVoucher: 10, ...overrides };
  return Object.keys(HEADERS).map((key) => data[key]);
}
const headers = Object.values(HEADERS);

test('order money is counted once regardless of products, bundles or duplicate input records', () => {
  const order = { ...base, salesSource: source };
  const result = summarizeSalesAccounting([order, order]);
  expect(result).toMatchObject({ calculatedSalesTotal: 95, sourceBackedSalesTotal: 95, sourceBackedOrderCount: 1 });
  expect(result.orders).toHaveLength(1);
  expect(summarizeSalesAccounting([order, { ...order, shopCode: 'dr-morepen' }]).calculatedSalesTotal).toBe(190);
  expect(() => resolveSalesOrders([base, { ...base, itemSubtotal: 101 }])).toThrow('Conflicting');
});

test('missing raw coverage remains provisional and missing money is not zero', () => {
  const summary = summarizeSalesAccounting([base]);
  expect(summary).toMatchObject({ status: 'provisional', calculatedSalesTotal: 100,
    sourceBackedSalesTotal: null, provisionalOrderCount: 1, periodReconciliation: 'not_checked' });
  expect(summary.orders[0]).toMatchObject({ sellerVoucher: null, shopeeProductDiscount: null, basis: 'email_estimate' });
  expect(summarizeSalesAccounting([{ ...base, itemSubtotal: null }])).toMatchObject({
    status: 'incomplete', calculatedSalesTotal: null, missingAmountOrderCount: 1,
  });
  expect(summarizeSalesAccounting([{ ...base, itemSubtotal: 0 }]).calculatedSalesTotal).toBe(0);
});

test('raw cancellation wins over stale shipping mail; terminal mail cannot be resurrected by raw', () => {
  expect(resolveSalesOrders([{ ...base, salesSource: { ...source, excluded: true } }])).toEqual([]);
  expect(resolveSalesOrders([{ ...base, currentStatus: 'order_cancelled', salesSource: source }])).toEqual([]);
  expect(resolveSalesOrders([{ ...base, currentStatus: 'seller_return_delivery' }])).toEqual([]);
});

test('financial arithmetic uses integer satang and rejects invalid precision/components', () => {
  expect(moneyCents('0.29')).toBe(29);
  expect(moneyCents('0.001')).toBe(null);
  expect(moneyCents('')).toBe(null);
  expect(moneyCents(-1)).toBe(null);
  expect(() => resolveSalesOrders([{ ...base, salesSource: { ...source, sellerVoucher: 101 } }])).toThrow('Invalid');
  const rows = [0.1, 0.2].map((amount, i) => ({ ...base, orderNumber: `260808TEST0${i}`, itemSubtotal: amount }));
  expect(summarizeSalesAccounting(rows).calculatedSalesTotal).toBe(0.3);
});

test('raw multi-line order sums line values but counts repeated seller voucher once', () => {
  const result = parseSalesSourceRows([headers, rawRow(), rawRow({ itemSubtotal: 70, shopeeProductDiscount: 3 })], options);
  expect(result.facts[0]).toMatchObject({ itemSubtotal: 120, sellerVoucher: 10, shopeeProductDiscount: 5, sourceRows: [2, 3] });
  expect(result.facts).toHaveLength(1);
});

test('strict status parsing permits delivered return-policy explanations, rejects unknown actual returns', () => {
  expect(classifyStatus('ผู้ซื้อได้รับสินค้าแล้ว โปรดทราบว่าผู้ซื้อสามารถยื่นคำขอคืนเงิน/คืนสินค้าได้จนถึง 2026-09-10').excluded).toBe(false);
  expect(classifyStatus('จัดส่งสำเร็จแล้ว').excluded).toBe(false);
  expect(classifyStatus('ยกเลิกแล้ว').excluded).toBe(true);
  expect(() => classifyStatus('กำลังคืนเงิน/คืนสินค้า')).toThrow('Unsupported');
});

test('source manifest and within-order conflicts fail closed; date comes from Thai timestamp not order ID', () => {
  const august = { ...options, sourceFilename: 'Order.all.20260824_20260830.xlsx' };
  const result = parseSalesSourceRows([headers, rawRow({ orderNumber: '260829JFTV2H9J', orderedAt: '2026-08-28 23:58' })], august);
  expect(result.facts[0].orderedAt).toBe('2026-08-28T16:58:00.000Z');
  expect(() => parseSalesSourceRows([headers, rawRow({ orderedAt: '2026-08-10 00:00' })], options)).toThrow('outside');
  expect(() => parseSalesSourceRows([headers, rawRow(), rawRow({ sellerVoucher: 11 })], options)).toThrow('Inconsistent');
  expect(() => parseSalesSourceRows([headers, rawRow(), rawRow({ status: 'ยกเลิกแล้ว' })], options)).toThrow('Inconsistent');
  expect(() => parseSalesSourceRows([headers, rawRow()], { ...options, shopCode: 'wrong-shop' })).toThrow();
  expect(() => parseSalesSourceRows([headers, rawRow({ itemSubtotal: { formula: '1+1', result: 2 } })], options)).toThrow();
  expect(() => parseSalesSourceRows([[...headers, headers[0]], rawRow()], options)).toThrow('duplicate header');
  expect(() => parseSalesSourceRows([headers, rawRow({ sellerVoucher: null })], options)).toThrow('Missing');
  expect(() => parseSalesSourceRows([headers, rawRow({ itemSubtotal: '1,2' })], options)).toThrow('invalid');
  expect(() => parseSalesSourceRows([headers, rawRow()], { ...options, observedAt: '2026-09-05' })).toThrow('timezone');
  expect(() => parseSalesSourceRows([headers, rawRow()], { ...options, observedAt: '2026-09-31T00:00:00Z' })).toThrow('calendar');
  expect(() => parseSalesSourceRows([headers, rawRow({ name: 'ชื่อผู้รับ: secret' })], options)).toThrow('privacy');
  expect(() => resolveSalesOrders([{ ...base, salesSource: source, items: [] }])).toThrow('no usable product');
});

test('CLI defaults to dry-run and requires explicit file arguments', () => {
  expect(parseArgs(['--file', 'input.xlsx']).apply).toBe(false);
  expect(() => parseArgs(['--unknown'])).toThrow('Unknown');
  expect(() => parseArgs(['--file', '--apply'])).toThrow('path');
});

test('local verifier rejects remote hosts and pg query-parameter host overrides without connecting', () => {
  expect(() => assertLocalDatabaseUrl('postgresql://test@127.0.0.1:55487/test')).not.toThrow();
  expect(() => assertLocalDatabaseUrl('postgresql://test@localhost/test?host=example.com')).toThrow('LOCAL');
  expect(() => assertLocalDatabaseUrl('postgresql://test@localhost/test?hostaddr=192.0.2.1')).toThrow('LOCAL');
  expect(() => assertLocalDatabaseUrl('postgresql://test@example.com/test')).toThrow('LOCAL');
  expect(() => assertLocalDatabaseUrl('not a URL')).toThrow('LOCAL');
});

test('source import rolls back the whole transaction on failure and never writes email orders', async () => {
  const queries = [];
  const client = { query: jest.fn(async (sql) => {
    queries.push(sql);
    if (sql.includes('INSERT INTO') && sql.includes('shopee_sales_order_facts')) throw new Error('test failure');
    return { rows: [] };
  }) };
  const parsed = parseSalesSourceRows([headers, rawRow()], options);
  await expect(importSalesSources([parsed], { client, actor: 'test' })).rejects.toThrow('test failure');
  expect(queries.at(-1)).toBe('ROLLBACK');
  expect(queries).not.toContain('COMMIT');
  expect(queries.join('\n')).not.toMatch(/(?:INSERT INTO|UPDATE|DELETE FROM) [^\n]*shopee_orders/);
});
