const ExcelJS = require('exceljs');
const { HEADERS, OVERVIEW_HEADERS, parseConfirmedSalesRows, summarizeConfirmedSales } = require('../src/modules/seamless/services/shopeeConfirmedSalesService');
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

function confirmedHourlyRows({ missingHour = null, malformedHour = null, summarySales = '100.25' } = {}) {
  const detailHeaders = Object.values(HEADERS);
  detailHeaders[0] = 'เวลา';
  const hourly = Array.from({ length: 24 }, (_, hour) => [
    `08-09-2026 ${String(hour).padStart(2, '0')}:${hour === malformedHour ? '30' : '00'}`,
    hour === 0 ? '100.25' : '0',
    hour === 0 ? '2' : '0',
    hour === 0 ? '1' : '0',
    hour === 0 ? '20.10' : '0',
    '0',
    '0',
  ]).filter((_, hour) => hour !== missingHour);
  return [Object.values(HEADERS), ['08-09-2026-08-09-2026', summarySales, '2', '1', '20.10', '0', '0'],
    [], detailHeaders, ...hourly];
}

function overviewRows({ missingHour = null, salesTotal = '100.25' } = {}) {
  const summaryHeaders = [OVERVIEW_HEADERS.date, 'จำนวนผู้เยี่ยมชม(การเข้าชม)',
    'จำนวนผู้ซื้อ (คำสั่งซื้อทั้งหมด)', 'ยอดขาย (ที่มีการสั่งซื้อทั้งหมด) (THB)',
    'จำนวนผู้ซื้อ (คำสั่งซื้อที่ได้รับการยืนยัน)', OVERVIEW_HEADERS.salesTotal];
  const summary = ['08-09-2026-08-09-2026', '10', '2', '120.00', '2', salesTotal];
  const dailyHeaders = Array.from({ length: 14 }, (_, index) => `unused-${index}`);
  dailyHeaders[0] = OVERVIEW_HEADERS.date;
  dailyHeaders[9] = OVERVIEW_HEADERS.orderCount;
  dailyHeaders[10] = OVERVIEW_HEADERS.salesTotal;
  const hourly = Array.from({ length: 24 }, (_, hour) => {
    const row = Array(14).fill('0');
    row[0] = `08-09-2026 ${String(hour).padStart(2, '0')}:00`;
    row[9] = hour === 0 ? '2' : '0';
    row[10] = hour === 0 ? '100.25' : '0';
    return row;
  }).filter((_, hour) => hour !== missingHour);
  return [summaryHeaders, summary, [], dailyHeaders, ...hourly];
}

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

test('current Sales Overview aggregates 24 hourly intervals using Shopee confirmed-order labels', () => {
  const source = parseConfirmedSalesRows(overviewRows(), {
    shopCode: 'sc-drug-store',
    sourceFilename: 'sales_overview_20260908-20260908.xlsx',
    sourceSha256: 'b'.repeat(64),
    observedAt: '2026-09-09T08:00:00+07:00',
  });
  expect(source).toMatchObject({ startDate: '2026-09-08', endDate: '2026-09-08',
    sheetName: 'ภาพรวมยอดขาย', reportFormat: 'sales-overview',
    control: { salesTotal: 100.25, orderCount: 2, cancelledSales: null } });
  expect(source.facts).toEqual([expect.objectContaining({ date: '2026-09-08',
    salesTotal: 100.25, orderCount: 2, cancelledSales: null, returnedSales: null })]);
  const summary = summarizeConfirmedSales(source.facts, {
    shopCode: 'sc-drug-store', startDate: '2026-09-08', endDate: '2026-09-08',
  });
  expect(summary).toMatchObject({ status: 'source_backed', salesTotal: 100.25,
    orderCount: 2, cancelledSales: null, salesAfterCancellation: null });
});

test('current Sales Overview rejects incomplete hourly evidence and summary mismatches', () => {
  const current = { shopCode: 'sc-drug-store',
    sourceFilename: 'sales_overview_20260908-20260908.xlsx',
    sourceSha256: 'b'.repeat(64), observedAt: '2026-09-09T08:00:00+07:00' };
  expect(() => parseConfirmedSalesRows(overviewRows({ missingHour: 23 }), current)).toThrow(/hourly coverage is incomplete/i);
  expect(() => parseConfirmedSalesRows(overviewRows({ salesTotal: '100.26' }), current)).toThrow(/daily\/summary mismatch/i);
});

test('official confirmed workbook aggregates a single-day 24-hour detail table including cancellations', () => {
  const source = parseConfirmedSalesRows(confirmedHourlyRows(), {
    shopCode: 'sc-drug-store',
    sourceFilename: '142wuxqhgi.shopee-shop-stats.20260908-20260908.xlsx',
    sourceSha256: 'c'.repeat(64),
    observedAt: '2026-09-09T08:00:00+07:00',
  });
  expect(source).toMatchObject({ startDate: '2026-09-08', endDate: '2026-09-08',
    sheetName: 'ยืนยันแล้ว', reportFormat: 'shop-stats-confirmed',
    control: { salesTotal: 100.25, orderCount: 2, cancelledOrderCount: 1,
      cancelledSales: 20.1, returnedOrderCount: 0, returnedSales: 0 } });
  expect(source.facts).toEqual([expect.objectContaining({ date: '2026-09-08',
    salesTotal: 100.25, orderCount: 2, cancelledOrderCount: 1,
    cancelledSales: 20.1, returnedOrderCount: 0, returnedSales: 0 })]);
});

test('official confirmed workbook rejects incomplete, malformed, or summary-mismatched hourly evidence', () => {
  const current = { shopCode: 'sc-drug-store',
    sourceFilename: '142wuxqhgi.shopee-shop-stats.20260908-20260908.xlsx',
    sourceSha256: 'c'.repeat(64), observedAt: '2026-09-09T08:00:00+07:00' };
  expect(() => parseConfirmedSalesRows(confirmedHourlyRows({ missingHour: 23 }), current))
    .toThrow(/hourly coverage is incomplete/i);
  expect(() => parseConfirmedSalesRows(confirmedHourlyRows({ malformedHour: 23 }), current))
    .toThrow(/invalid hourly statistics interval/i);
  expect(() => parseConfirmedSalesRows(confirmedHourlyRows({ summarySales: '100.26' }), current))
    .toThrow(/daily\/summary mismatch/i);
});

test('summary exposes source filename, hash, observation, import and latest covered date for audit', () => {
  const source = parse();
  const importedAt = '2026-09-08T00:05:00.000Z';
  const enriched = source.facts.map(row => ({ ...row, sourceFilename: source.sourceFilename,
    sourceSha256: source.sourceSha256, observedAt: source.observedAt, importedAt }));
  const result = summarizeConfirmedSales(enriched, filters);
  expect(result).toMatchObject({ latestDataDate: '2026-08-02', latestObservedAt: source.observedAt,
    latestImportedAt: importedAt });
  expect(result.sources).toEqual([expect.objectContaining({ shopCode: 'sc-drug-store',
    sourceFilename: source.sourceFilename, sourceSha256: source.sourceSha256,
    observedAt: source.observedAt, importedAt, coveredStartDate: '2026-08-01',
    coveredEndDate: '2026-08-02', coveredDays: 2 })]);
  expect(result.shops[0].sources).toEqual(result.sources);
});

test('summary keeps metric-level provenance when a newer thin report is combined with older complete evidence', () => {
  const thin = {
    shopCode: 'sc-drug-store', date: '2026-08-01', salesTotal: 100.25, orderCount: 2,
    cancelledSales: 20.1, cancelledOrderCount: 1, returnedSales: 0, returnedOrderCount: 0,
    sourceRow: 5, sourceFilename: 'sales_overview_20260801-20260801.xlsx',
    sourceSha256: 'b'.repeat(64), observedAt: '2026-09-10T00:00:00.000Z',
    importedAt: '2026-09-10T00:01:00.000Z',
    metricEvidence: {
      confirmedSales: { sourceRow: 5, sourceFilename: 'sales_overview_20260801-20260801.xlsx',
        sourceSha256: 'b'.repeat(64), observedAt: '2026-09-10T00:00:00.000Z', importedAt: '2026-09-10T00:01:00.000Z' },
      cancellations: { sourceRow: 5, sourceFilename: '142wuxqhgi.shopee-shop-stats.20260801-20260801.xlsx',
        sourceSha256: 'a'.repeat(64), observedAt: '2026-09-08T00:00:00.000Z', importedAt: '2026-09-08T00:01:00.000Z' },
      returns: { sourceRow: 5, sourceFilename: '142wuxqhgi.shopee-shop-stats.20260801-20260801.xlsx',
        sourceSha256: 'a'.repeat(64), observedAt: '2026-09-08T00:00:00.000Z', importedAt: '2026-09-08T00:01:00.000Z' },
    },
  };
  const result = summarizeConfirmedSales([thin], {
    shopCode: 'sc-drug-store', startDate: '2026-08-01', endDate: '2026-08-01',
  });

  expect(result).toMatchObject({ salesTotal: 100.25, cancelledSales: 20.1, returnedSales: 0 });
  expect(result.sources).toEqual([
    expect.objectContaining({ sourceSha256: 'b'.repeat(64), metrics: ['orderCount', 'salesTotal'] }),
    expect.objectContaining({ sourceSha256: 'a'.repeat(64), metrics: [
      'cancelledOrderCount', 'cancelledSales', 'returnedOrderCount', 'returnedSales',
    ] }),
  ]);
});

test('admin export puts confirmed gross first and preserves separate net order/SKU ledgers', async () => {
  const source = parse();
  const confirmedSales = summarizeConfirmedSales(source.facts.map(row => ({ ...row,
    sourceFilename: source.sourceFilename, sourceSha256: source.sourceSha256,
    observedAt: source.observedAt })), filters);
  const orders = [{ shopCode: 'sc-drug-store', orderNumber: 'TESTORDER01', orderedAt: '2026-08-01T01:00:00Z',
    itemSubtotal: 75, items: [{ name: 'สินค้า', quantity: 1 }] }];
  const exported = await buildShopeeSalesExportWorkbook(orders, { confirmedSales });
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(exported.buffer);
  expect(workbook.worksheets[0].name).toBe('ยอดขายที่ได้รับการยืนยัน');
  const sheet = workbook.worksheets[0];
  expect(sheet.getCell('C2').value).toBe(100.25);
  expect(sheet.getCell('D2').value).toBe(2);
  expect(sheet.getCell('E2').value).toBe(20.1);
  expect(sheet.getCell('F2').value).toBe(80.15);
  const daily = workbook.getWorksheet('ภาพรวมยอดขายรายวัน');
  let dailyCents = 0;
  daily.eachRow((row, n) => { if (n > 1) dailyCents += Math.round(row.getCell(3).value * 100); });
  expect(dailyCents).toBe(10025);
  expect(workbook.getWorksheet('ยอดขายรายออเดอร์').getCell('G2').value).toBe(75);
  expect(workbook.getWorksheet('ยอดขายรายออเดอร์').getCell('G1').value).toContain('ไม่ใช่ยอดยืนยันแล้ว');
  expect(workbook.getWorksheet('พร้อมคีย์').columnCount).toBe(7);
  expect(sheet.pageSetup).toMatchObject({ orientation: 'landscape', paperSize: 9, fitToWidth: 1 });
  const hidden = await buildShopeeSalesExportWorkbook(orders, { confirmedSales, includeAccounting: false });
  const userWorkbook = new ExcelJS.Workbook(); await userWorkbook.xlsx.load(hidden.buffer);
  expect(userWorkbook.getWorksheet('ยอดขายที่ได้รับการยืนยัน')).toBeUndefined();
});

test('incomplete confirmed export leaves money blank and explicitly lists missing days', async () => {
  const confirmedSales = summarizeConfirmedSales([], filters);
  const exported = await buildShopeeSalesExportWorkbook([], { confirmedSales });
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(exported.buffer);
  const sheet = workbook.worksheets[0];
  expect(sheet.getCell('C2').value).toBeNull();
  expect(sheet.getCell('G2').value).toContain('ขาด 2 วัน');
  const daily = workbook.getWorksheet('ภาพรวมยอดขายรายวัน');
  expect(daily.getRow(daily.rowCount).getCell(7).value).toBe('ขาดรายงาน Business Insights');
});

test('confirmed importer retains dry-run default and accepts only a named report type', () => {
  expect(parseArgs(['--type', 'confirmed', '--file', 'test.xlsx']).apply).toBe(false);
  expect(() => parseArgs(['--type', 'all', '--file', 'test.xlsx'])).toThrow();
});
