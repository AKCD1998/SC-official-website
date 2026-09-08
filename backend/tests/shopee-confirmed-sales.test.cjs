const ExcelJS = require('exceljs');
const { HEADERS, parseConfirmedSalesRows, summarizeConfirmedSales } = require('../src/modules/seamless/services/shopeeConfirmedSalesService');
const { buildShopeeSalesExportWorkbook } = require('../src/modules/seamless/services/shopeeSalesSummaryExportService');
const { parseArgs } = require('../scripts/import-shopee-sales-sources.cjs');
const options = { shopCode: 'sc-drug-store', sourceFilename: '142wuxqhgi.shopee-shop-stats.20260801-20260802.xlsx',
  sourceSha256: 'a'.repeat(64), observedAt: '2026-09-08T00:00:00+07:00' };
const filters = { shopCode: 'sc-drug-store', startDate: '2026-08-01', endDate: '2026-08-02' };
function rows() {
  return [Object.values(HEADERS), ['01-08-2026-02-08-2026', '100.25', '2', '1', '20.10', '0', '0'], [], Object.values(HEADERS),
    ['01-08-2026', '100.25', '2', '1', '20.10', '0', '0'], ['02-08-2026', '0', '0', '0', '0', '0', '0']];
}
const parse = (values = rows(), opts = {}) => parseConfirmedSalesRows(values, { ...options, ...opts });

test('confirmed gross stays primary; cancellations/counts separate, explicit zero day is covered', () => {
  const source = parse();
  const result = summarizeConfirmedSales(source.facts, filters);
  expect(result).toMatchObject({ metric: 'shopee_confirmed_gross_sales', dateBasis: 'confirmed_report_date',
    status: 'source_backed', salesTotal: 100.25, orderCount: 2, cancelledSales: 20.1,
    cancelledOrderCount: 1, salesAfterCancellation: 80.15, coveredDays: 2 });
  expect(result.missingDays).toEqual([]);
  expect(source.control).toMatchObject({ salesTotal: 100.25, orderCount: 2 });
});

test.each([
  ['wrong shop', () => rows(), { shopCode: 'dr-morepen' }],
  ['bad observed date', () => rows(), { observedAt: '2026-09-31T00:00:00Z' }],
  ['unclosed report period', () => rows(), { observedAt: '2026-08-02T12:00:00Z' }],
  ['bad hash', () => rows(), { sourceSha256: '123' }],
  ['impossible source date', () => rows(), { sourceFilename: '142wuxqhgi.shopee-shop-stats.20260801-20260931.xlsx' }],
  ['wrong source period', () => { const v = rows(); v[1][0] = '01-08-2026-03-08-2026'; return v; }, {}],
  ['missing header', () => { const v = rows(); v[0][1] = 'ยอดขายที่ไม่รวมส่วนลดจาก Shopee'; return v; }, {}],
  ['duplicate header', () => { const v = rows(); v[0].push(HEADERS.salesTotal); return v; }, {}],
  ['missing repeated header', () => { const v = rows(); v[3] = []; return v; }, {}],
  ['missing zero day', () => rows().slice(0, 5), {}],
  ['duplicate day', () => { const v = rows(); v[5][0] = '01-08-2026'; return v; }, {}],
  ['out of range day', () => { const v = rows(); v[5][0] = '03-08-2026'; return v; }, {}],
  ['summary mismatch', () => { const v = rows(); v[1][1] = '110.25'; return v; }, {}],
  ['bad commas', () => { const v = rows(); v[1][1] = '1,00.25'; return v; }, {}],
  ['missing money', () => { const v = rows(); v[4][1] = null; return v; }, {}],
  ['formula', () => { const v = rows(); v[4][1] = { formula: '100+0.25', result: 100.25 }; return v; }, {}],
  ['overprecision', () => { const v = rows(); v[4][1] = '100.251'; return v; }, {}],
  ['fractional order count', () => { const v = rows(); v[4][2] = '2.5'; return v; }, {}],
  ['cancel exceeds gross', () => { const v = rows(); v[4][4] = '101'; return v; }, {}],
  ['returns control mismatch', () => { const v = rows(); v[1][6] = '1'; return v; }, {}],
])('rejects invalid source: %s', (_, factory, opts) => {
  expect(() => parse(factory(), opts)).toThrow();
});

test('missing official day or shop makes primary null, not a partial sum or email fallback', () => {
  const source = parse();
  const incomplete = summarizeConfirmedSales(source.facts.slice(0, 1), filters);
  expect(incomplete).toMatchObject({ status: 'incomplete', salesTotal: null, orderCount: null, salesAfterCancellation: null });
  expect(incomplete.missingDays).toEqual([{ shopCode: 'sc-drug-store', date: '2026-08-02' }]);
  const combined = summarizeConfirmedSales(source.facts, { ...filters, shopCode: 'all' });
  expect(combined.salesTotal).toBeNull();
  expect(combined.shops[0].salesTotal).toBe(100.25);
  expect(combined.shops[1].salesTotal).toBeNull();
  expect(summarizeConfirmedSales([], filters).salesTotal).toBeNull();
});

test('date subset selects only official daily values and rejects duplicate or foreign-scope rows', () => {
  const source = parse();
  expect(summarizeConfirmedSales(source.facts.slice(1), { ...filters, startDate: '2026-08-02' }).salesTotal).toBe(0);
  expect(() => summarizeConfirmedSales([...source.facts, source.facts[0]], filters)).toThrow();
  expect(() => summarizeConfirmedSales(source.facts, { ...filters, shopCode: 'dr-morepen' })).toThrow();
});

test('admin export puts confirmed gross first and preserves separate net order/SKU ledgers', async () => {
  const source = parse();
  const confirmedSales = summarizeConfirmedSales(source.facts.map(row => ({ ...row,
    sourceFilename: source.sourceFilename, sourceSha256: source.sourceSha256 })), filters);
  const orders = [{ shopCode: 'sc-drug-store', orderNumber: 'TESTORDER01', orderedAt: '2026-08-01T01:00:00Z',
    itemSubtotal: 75, items: [{ name: 'สินค้า', quantity: 1 }] }];
  const exported = await buildShopeeSalesExportWorkbook(orders, { confirmedSales });
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(exported.buffer);
  expect(workbook.worksheets[0].name).toBe('ยอดขายยืนยันแล้ว');
  const sheet = workbook.worksheets[0];
  expect(sheet.getCell('C2').value).toBe(100.25);
  expect(sheet.getCell('D2').value).toBe(2);
  expect(sheet.getCell('E2').value).toBe(20.1);
  expect(sheet.getCell('F2').value).toBe(80.15);
  const daily = workbook.getWorksheet('ยืนยันแล้วรายวัน');
  let dailyCents = 0;
  daily.eachRow((row, n) => { if (n > 1) dailyCents += Math.round(row.getCell(3).value * 100); });
  expect(dailyCents).toBe(10025);
  expect(workbook.getWorksheet('ยอดขายรายออเดอร์').getCell('G2').value).toBe(75);
  expect(workbook.getWorksheet('ยอดขายรายออเดอร์').getCell('G1').value).toContain('ไม่ใช่ยอดยืนยันแล้ว');
  expect(workbook.getWorksheet('พร้อมคีย์').columnCount).toBe(7);
  expect(sheet.pageSetup).toMatchObject({ orientation: 'landscape', paperSize: 9, fitToWidth: 1 });
  const hidden = await buildShopeeSalesExportWorkbook(orders, { confirmedSales, includeAccounting: false });
  const userWorkbook = new ExcelJS.Workbook(); await userWorkbook.xlsx.load(hidden.buffer);
  expect(userWorkbook.getWorksheet('ยอดขายยืนยันแล้ว')).toBeUndefined();
});

test('incomplete confirmed export leaves money blank and explicitly lists missing days', async () => {
  const confirmedSales = summarizeConfirmedSales([], filters);
  const exported = await buildShopeeSalesExportWorkbook([], { confirmedSales });
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(exported.buffer);
  const sheet = workbook.worksheets[0];
  expect(sheet.getCell('C2').value).toBeNull();
  expect(sheet.getCell('G2').value).toContain('ขาด 2 วัน');
  const daily = workbook.getWorksheet('ยืนยันแล้วรายวัน');
  expect(daily.getRow(daily.rowCount).getCell(7).value).toBe('ขาดรายงานยืนยันแล้ว');
});

test('confirmed importer retains dry-run default and accepts only a named report type', () => {
  expect(parseArgs(['--type', 'confirmed', '--file', 'test.xlsx']).apply).toBe(false);
  expect(() => parseArgs(['--type', 'all', '--file', 'test.xlsx'])).toThrow();
});
