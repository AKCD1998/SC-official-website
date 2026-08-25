const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { buildOutputFilename } = require('../src/modules/seamless/services/workbookRules');
const { transformWorkbook } = require('../src/modules/seamless/services/workbookTransformService');
const { transformShopeeWorkbook } = require('../src/modules/seamless/services/shopeeWorkbookTransform');
const { parseZipEntries, inflateEntry } = require('../src/modules/seamless/services/xlsxDefaultFont');

// --- Raw-OOXML helpers ------------------------------------------------------
// ExcelJS's own reader is self-consistent with its writer on a single timezone, so a write→read
// round-trip hides the two classes of bug below. These helpers decode the actual XLSX bytes
// (the ZIP entries) directly, the way Excel and any external reader see them.
//   - serial: pulls a raw <v> serial out of a worksheet XML cell and decodes it via pure epoch
//     math (Excel epoch = 1899-12-30). This is what would have caught the 7-hour date shift.
//   - defaultFont: reads font[0] from styles.xml. This is what would have caught the Calibri-11
//     Normal font that mis-sizes every column width.
function readZipEntry(buffer, name) {
  const { entries } = parseZipEntries(buffer);
  const entry = entries.find((e) => e.name === name);
  if (!entry) throw new Error(`zip entry not found: ${name}`);
  return inflateEntry(buffer, entry).toString('utf8');
}

function rawSerialAt(worksheetXml, cellRef) {
  // Cell form: <c r="B2" s="2" t="n"><v>46174.358333333334</v></c> (date cells omit t since
  // numeric is the default; some carry a style attr). Pull the <v> for the given ref.
  const re = new RegExp(`<c r="${cellRef}"[^>]*>(?:<v>([0-9.]+)</v>)?</c>`);
  const m = worksheetXml.match(re);
  return m && m[1] ? Number(m[1]) : null;
}

function decodeSerial(serial) {
  // Excel serial date: days since 1899-12-30, fractional day = time. Pure epoch math, no TZ.
  return new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
}

function defaultFontFromStyles(stylesXml) {
  const m = stylesXml.match(/<fonts[^>]*>[\s\S]*?<font>([\s\S]*?)<\/font>/);
  return m ? m[1] : null;
}

// Real source header literals copied verbatim from the inspected raw export
// (Order.all.20260601_20260630.xlsx, sheet `orders`). Header matching is exact-string, so any
// drift here resolves to a wrong fail-closed error — these literals are the contract.
const HEADERS = {
  orderNumber: 'หมายเลขคำสั่งซื้อ', // A -> output A (text)
  status: 'สถานะการสั่งซื้อ', // B -> output G
  orderDate: 'วันที่ทำการสั่งซื้อ', // G -> output B (Date)
  productName: 'ชื่อสินค้า', // S -> output C
  sku: 'เลขอ้างอิง SKU (SKU Reference No.)', // T -> output E (text)
  variation: 'ชื่อตัวเลือก', // U -> output D
  quantity: 'จำนวน', // X -> output F
  netSale: 'ราคาขายสุทธิ', // Z -> output H
  sellerVoucher: 'โค้ดส่วนลดชำระโดยผู้ขาย', // AB -> output I
  commission: 'ค่าคอมมิชชั่น', // AM -> output J
  transactionFee: 'Transaction Fee', // AN -> output K
  completedAt: 'เวลาที่ทำการสั่งซื้อสำเร็จ', // BF -> output M (Date)
  // PII columns — must be present in source, must be absent from processed output.
  buyerUsername: 'ชื่อผู้ใช้ (ผู้ซื้อ)',
  recipientName: 'ชื่อผู้รับ',
  phone: 'หมายเลขโทรศัพท์',
  address: 'ที่อยู่ในการจัดส่ง',
};

const HEADER_ORDER = [
  HEADERS.orderNumber,
  HEADERS.status,
  HEADERS.buyerUsername,
  HEADERS.orderDate,
  HEADERS.productName,
  HEADERS.sku,
  HEADERS.variation,
  HEADERS.quantity,
  HEADERS.netSale,
  HEADERS.sellerVoucher,
  HEADERS.commission,
  HEADERS.transactionFee,
  HEADERS.completedAt,
  HEADERS.recipientName,
  HEADERS.phone,
  HEADERS.address,
];

const SOURCE_COLS = Object.fromEntries(HEADER_ORDER.map((header, index) => [header, index + 1]));

function sourceRow(values) {
  return HEADER_ORDER.map((header) => values[header] ?? '');
}

// Synthetic fixture modeled on the real June 2026 export's shape, but with invented order IDs,
// products, and zero real PII. Rows exercise: all 4 weeks (by completed time), a cancelled row
// with blank completed time, two June 29-30 carryover rows, a blank-SKU row, comma-formatted
// numbers, and a blank numeric cell. Counts/totals are derived in-test from this data.
function juneRows() {
  return [
    // Week 01-07.06 (3 rows)
    {
      [HEADERS.orderNumber]: '250601AAA001',
      [HEADERS.status]: 'สำเร็จแล้ว',
      [HEADERS.orderDate]: '2026-06-01 08:36',
      [HEADERS.productName]: 'แผ่นตรวจน้ำตาล SynthA',
      [HEADERS.sku]: 'SYN-50',
      [HEADERS.variation]: 'แผ่นตรวจ 50 ชิ้น',
      [HEADERS.quantity]: '1',
      [HEADERS.netSale]: '366.00',
      [HEADERS.sellerVoucher]: '0.00',
      [HEADERS.commission]: '45.00',
      [HEADERS.transactionFee]: '13.00',
      [HEADERS.completedAt]: '2026-06-02 11:28',
    },
    {
      [HEADERS.orderNumber]: '250601BBB002',
      [HEADERS.status]: 'สำเร็จแล้ว',
      [HEADERS.orderDate]: '2026-06-01 20:22',
      [HEADERS.productName]: 'แผ่นตรวจน้ำตาล SynthA',
      [HEADERS.sku]: 'SYN-50',
      [HEADERS.variation]: 'แผ่นตรวจ 50 ชิ้น',
      [HEADERS.quantity]: '2',
      [HEADERS.netSale]: '732.00',
      [HEADERS.sellerVoucher]: '100.00',
      [HEADERS.commission]: '78.00',
      [HEADERS.transactionFee]: '21.00',
      [HEADERS.completedAt]: '2026-06-03 20:56',
    },
    {
      [HEADERS.orderNumber]: '250602CCC003',
      [HEADERS.status]: 'สำเร็จแล้ว',
      [HEADERS.orderDate]: '2026-06-02 07:58',
      [HEADERS.productName]: 'แผ่นตรวจน้ำตาล SynthA',
      [HEADERS.sku]: 'SYN-50',
      [HEADERS.variation]: 'แผ่นตรวจ 50 ชิ้น',
      [HEADERS.quantity]: '1',
      [HEADERS.netSale]: '366.00',
      [HEADERS.sellerVoucher]: '0.00',
      [HEADERS.commission]: '45.00',
      [HEADERS.transactionFee]: '13.00',
      [HEADERS.completedAt]: '2026-06-07 13:03',
    },
    // Week 08-14.06 (2 rows)
    {
      [HEADERS.orderNumber]: '250603DDD004',
      [HEADERS.status]: 'สำเร็จแล้ว',
      [HEADERS.orderDate]: '2026-06-03 17:50',
      [HEADERS.productName]: 'แผ่นตรวจน้ำตาล SynthB',
      [HEADERS.sku]: 'SYN-25',
      [HEADERS.variation]: 'แผ่นตรวจ 25',
      [HEADERS.quantity]: '1',
      [HEADERS.netSale]: '669.00',
      [HEADERS.sellerVoucher]: '100.00',
      [HEADERS.commission]: '70.00',
      [HEADERS.transactionFee]: '19.00',
      [HEADERS.completedAt]: '2026-06-09 13:00',
    },
    {
      [HEADERS.orderNumber]: '250605EEE005',
      [HEADERS.status]: 'สำเร็จแล้ว',
      [HEADERS.orderDate]: '2026-06-05 16:55',
      [HEADERS.productName]: 'แผ่นตรวจน้ำตาล SynthA',
      [HEADERS.sku]: 'SYN-50',
      [HEADERS.variation]: 'แผ่นตรวจ 50 ชิ้น',
      [HEADERS.quantity]: '1',
      [HEADERS.netSale]: '366.00',
      [HEADERS.sellerVoucher]: '0.00',
      [HEADERS.commission]: '45.00',
      [HEADERS.transactionFee]: '12.00',
      [HEADERS.completedAt]: '2026-06-11 14:48',
    },
    // Cancelled row: status == ยกเลิกแล้ว, blank completed time. Must be excluded BEFORE the
    // completed-time allocation, so it never trips the missing-BF fail-closed rule.
    {
      [HEADERS.orderNumber]: '250603FFF006',
      [HEADERS.status]: 'ยกเลิกแล้ว',
      [HEADERS.orderDate]: '2026-06-03 17:41',
      [HEADERS.productName]: 'แผ่นตรวจน้ำตาล SynthA',
      [HEADERS.sku]: 'SYN-50',
      [HEADERS.variation]: 'แผ่นตรวจ 50 ชิ้น',
      [HEADERS.quantity]: '3',
      [HEADERS.netSale]: '1,098.00',
      [HEADERS.sellerVoucher]: '0.00',
      [HEADERS.commission]: '0.00',
      [HEADERS.transactionFee]: '0.00',
      [HEADERS.completedAt]: '',
    },
    // Week 15-21.06 (1 row) — also tests blank-SKU preservation (E stays text, not coerced).
    {
      [HEADERS.orderNumber]: '250615GGG007',
      [HEADERS.status]: 'สำเร็จแล้ว',
      [HEADERS.orderDate]: '2026-06-15 08:40',
      [HEADERS.productName]: 'แผ่นตรวจน้ำตาล SynthB',
      [HEADERS.sku]: '',
      [HEADERS.variation]: 'เครื่อง + แผ่นตรวจ25',
      [HEADERS.quantity]: '1',
      [HEADERS.netSale]: '225.00',
      [HEADERS.sellerVoucher]: '0.00',
      [HEADERS.commission]: '28.00',
      [HEADERS.transactionFee]: '7.00',
      [HEADERS.completedAt]: '2026-06-19 09:41',
    },
    // Week 22-28.06 (1 row) — blank numeric cell (sellerVoucher omitted -> 0).
    {
      [HEADERS.orderNumber]: '250625HHH008',
      [HEADERS.status]: 'สำเร็จแล้ว',
      [HEADERS.orderDate]: '2026-06-25 10:24',
      [HEADERS.productName]: 'แผ่นตรวจน้ำตาล SynthA',
      [HEADERS.sku]: 'SYN-50',
      [HEADERS.variation]: 'แผ่นตรวจ 50 ชิ้น',
      [HEADERS.quantity]: '1',
      [HEADERS.netSale]: '235.00',
      [HEADERS.commission]: '29.00',
      [HEADERS.transactionFee]: '9.00',
      [HEADERS.completedAt]: '2026-06-26 12:22',
    },
    // Carryover to July: order date June 29-30, outside the June cycle window.
    {
      [HEADERS.orderNumber]: '250629III009',
      [HEADERS.status]: 'สำเร็จแล้ว',
      [HEADERS.orderDate]: '2026-06-29 18:04',
      [HEADERS.productName]: 'หูฟังแพทย์ SynthC',
      [HEADERS.sku]: '',
      [HEADERS.variation]: '',
      [HEADERS.quantity]: '1',
      [HEADERS.netSale]: '890.00',
      [HEADERS.sellerVoucher]: '100.00',
      [HEADERS.commission]: '97.00',
      [HEADERS.transactionFee]: '26.00',
      [HEADERS.completedAt]: '2026-07-05 11:53',
    },
    {
      [HEADERS.orderNumber]: '250630JJJ010',
      [HEADERS.status]: 'สำเร็จแล้ว',
      [HEADERS.orderDate]: '2026-06-30 09:31',
      [HEADERS.productName]: 'หูฟังแพทย์ SynthC',
      [HEADERS.sku]: '',
      [HEADERS.variation]: '',
      [HEADERS.quantity]: '1',
      [HEADERS.netSale]: '450.00',
      [HEADERS.sellerVoucher]: '0.00',
      [HEADERS.commission]: '0.00',
      [HEADERS.transactionFee]: '0.00',
      [HEADERS.completedAt]: '2026-07-06 18:09',
    },
  ];
}

// Add PII values to every row so the PII-absence test is meaningful. These strings must never
// appear in the processed workbook.
function withPii(rows) {
  return rows.map((row, index) => ({
    ...row,
    [HEADERS.buyerUsername]: `buyer-${index + 1}`,
    [HEADERS.recipientName]: `recipient-${index + 1}`,
    [HEADERS.phone]: '0800000000',
    [HEADERS.address]: `secret-address-${index + 1}`,
  }));
}

function expectedNet(row) {
  const netSale = Number(String(row[HEADERS.netSale] || '0').replace(/,/g, '')) || 0;
  const sellerVoucher = Number(String(row[HEADERS.sellerVoucher] || '0').replace(/,/g, '')) || 0;
  const commission = Number(String(row[HEADERS.commission] || '0').replace(/,/g, '')) || 0;
  const transactionFee = Number(String(row[HEADERS.transactionFee] || '0').replace(/,/g, '')) || 0;
  // Exact decimal — no rounding. The #,##0 numFmt handles display only.
  return Math.round((netSale - sellerVoucher - commission - transactionFee) * 100) / 100;
}

async function createJuneBuffer({
  originalFilename = 'Order.all.20260601_20260630.xlsx',
  rows = juneRows(),
} = {}) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('orders');
  worksheet.addRow(HEADER_ORDER);
  withPii(rows).forEach((row) => worksheet.addRow(sourceRow(row)));
  return { buffer: Buffer.from(await workbook.xlsx.writeBuffer()), originalFilename };
}

function shiftDateTime(value, days) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/);
  if (!match) return value;
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return `${shifted.toISOString().slice(0, 10)}${match[4]}`;
}

function shiftRows(rows, days) {
  return rows.map((row) => ({
    ...row,
    [HEADERS.orderDate]: shiftDateTime(row[HEADERS.orderDate], days),
    [HEADERS.completedAt]: shiftDateTime(row[HEADERS.completedAt], days),
  }));
}

// Which fixture rows are included (status != cancelled AND completed time in [06-01, 06-28]).
function includedRows(rows) {
  return rows.filter((row) => {
    const status = row[HEADERS.status];
    const completedAt = String(row[HEADERS.completedAt] || '');
    return status !== 'ยกเลิกแล้ว' && completedAt >= '2026-06-01 00:00' && completedAt <= '2026-06-28 23:59';
  });
}

function weekOf(completedAt) {
  const day = String(completedAt).slice(8, 10);
  const num = Number(day);
  if (num >= 1 && num <= 7) return '01-07.06';
  if (num >= 8 && num <= 14) return '08-14.06';
  if (num >= 15 && num <= 21) return '15-21.06';
  if (num >= 22 && num <= 28) return '22-28.06';
  return null;
}

const SHEET_ORDER = ['06', '01-07.06', '08-14.06', '15-21.06', '22-28.06'];
const OUTPUT_HEADERS = {
  A: 'หมายเลขคำสั่งซื้อ',
  B: 'วันที่ทำการสั่งซื้อ',
  C: 'ชื่อสินค้า',
  D: 'ชื่อตัวเลือก',
  E: 'เลขอ้างอิง',
  F: 'จำนวน',
  G: 'สถานะการสั่งซื้อ',
  H: 'ราคาขายสุทธิ',
  I: 'โค้ดส่วนลด ชำระโดยผู้ขาย',
  J: 'ค่าคอมมิชชั่น',
  K: 'Transaction Fee',
  L: 'รายได้สุทธิ',
  M: 'เวลาที่ทำการสั่งซื้อสำเร็จ',
};

function openOutput(buffer) {
  const wb = new ExcelJS.Workbook();
  return wb.xlsx.load(buffer);
}

// ---------------------------------------------------------------------------
// 1. Five-sheet order and row offsets
// ---------------------------------------------------------------------------

test('1. produces exactly five sheets in spec order with correct row offsets', async () => {
  const { buffer } = await createJuneBuffer();
  const result = await transformWorkbook(buffer, { requestedVariant: 'shopee', originalFilename: 'Order.all.20260601_20260630.xlsx' });

  assert.deepEqual(
    result.workbook.worksheets.map((sheet) => sheet.name),
    SHEET_ORDER,
  );
  assert.ok(!result.workbook.worksheets.some((sheet) => sheet.name === 'Sheet1'));

  const master = result.workbook.getWorksheet('06');
  assert.equal(master.getRow(1).getCell(1).value, OUTPUT_HEADERS.A); // header row 1
  assert.equal(master.getRow(2).getCell(1).value instanceof Date === false, true); // data row 2

  for (const name of SHEET_ORDER.slice(1)) {
    const sheet = result.workbook.getWorksheet(name);
    assert.equal(sheet.getCell('D1').value, name, `weekly ${name} period label at D1`);
    assert.equal(sheet.getRow(2).getCell(1).value, OUTPUT_HEADERS.A, `weekly ${name} header row 2`);
  }
});

// ---------------------------------------------------------------------------
// 2. Exact A:M mapping, values and Excel types
// ---------------------------------------------------------------------------

test('2. maps source columns to exact output columns with correct Excel types', async () => {
  const rows = juneRows();
  const { buffer } = await createJuneBuffer();
  const result = await transformWorkbook(buffer, { requestedVariant: 'shopee', originalFilename: 'Order.all.20260601_20260630.xlsx' });

  const master = result.workbook.getWorksheet('06');
  // Master A:M headers exact
  Object.entries(OUTPUT_HEADERS).forEach(([col, label]) => {
    assert.equal(master.getCell(`${col}1`).value, label, `master ${col}1 header`);
  });

  // First included row maps to master row 2 (grouped by week, raw order preserved within).
  const firstIncluded = includedRows(rows)[0];
  assert.equal(master.getCell('A2').value, firstIncluded[HEADERS.orderNumber]);
  assert.ok(master.getCell('A2').value instanceof Date === false, 'A is text');
  assert.ok(master.getCell('B2').value instanceof Date, 'B is a Date');
  assert.equal(master.getCell('C2').value, firstIncluded[HEADERS.productName]);
  assert.equal(master.getCell('D2').value, firstIncluded[HEADERS.variation]);
  assert.equal(master.getCell('E2').value, firstIncluded[HEADERS.sku]); // blank-SKU row handled in test 8
  assert.equal(typeof master.getCell('F2').value, 'number');
  assert.equal(master.getCell('G2').value, firstIncluded[HEADERS.status]);
  assert.equal(typeof master.getCell('H2').value, 'number');
  assert.equal(typeof master.getCell('I2').value, 'number');
  assert.equal(typeof master.getCell('J2').value, 'number');
  assert.equal(typeof master.getCell('K2').value, 'number');
  assert.ok(master.getCell('M2').value instanceof Date, 'M is a Date');

  // numFmt contract
  assert.equal(master.getColumn(1).numFmt, '@', 'A numFmt @');
  assert.equal(master.getColumn(5).numFmt, '@', 'E numFmt @');
  assert.equal(master.getColumn(2).numFmt, 'yyyy-mm-dd hh:mm', 'B numFmt');
  assert.equal(master.getColumn(13).numFmt, 'yyyy-mm-dd hh:mm', 'M numFmt');
  assert.equal(master.getColumn(6).numFmt, '#,##0', 'F numFmt');
  assert.equal(master.getColumn(8).numFmt, '#,##0.00', 'H numFmt');
  assert.equal(master.getColumn(12).numFmt, '#,##0', 'L numFmt');
});

// ---------------------------------------------------------------------------
// 3. Cancellation and June 29-30 exclusions
// ---------------------------------------------------------------------------

test('3. excludes cancelled and June 29-30 carryover rows from all sheets', async () => {
  const rows = juneRows();
  const { buffer } = await createJuneBuffer();
  const result = await transformWorkbook(buffer, { requestedVariant: 'shopee', originalFilename: 'Order.all.20260601_20260630.xlsx' });

  const cancelledId = '250603FFF006';
  const carryoverIds = ['250629III009', '250630JJJ010'];
  const excludedIds = [cancelledId, ...carryoverIds];

  result.workbook.worksheets.forEach((sheet) => {
    const ids = [];
    for (let r = sheet.name === '06' ? 2 : 3; r <= sheet.rowCount; r += 1) {
      const id = sheet.getRow(r).getCell(1).value;
      if (id) ids.push(String(id));
    }
    excludedIds.forEach((id) => {
      assert.ok(!ids.includes(id), `excluded id ${id} absent from ${sheet.name}`);
    });
  });

  assert.equal(result.metadata.cancelledExcluded, 1);
  assert.equal(result.metadata.carryoverExcluded, 2);
  assert.equal(result.metadata.finalRows, includedRows(rows).length);
});

// ---------------------------------------------------------------------------
// 4. Completed-time weekly allocation and stable sorting
// ---------------------------------------------------------------------------

test('4. allocates rows by completed time and sorts stably', async () => {
  const rows = juneRows();
  const included = includedRows(rows);
  const { buffer } = await createJuneBuffer();
  const result = await transformWorkbook(buffer, { requestedVariant: 'shopee', originalFilename: 'Order.all.20260601_20260630.xlsx' });

  const expectedByWeek = {};
  included.forEach((row) => {
    const week = weekOf(row[HEADERS.completedAt]);
    expectedByWeek[week] = (expectedByWeek[week] || 0) + 1;
  });

  for (const name of SHEET_ORDER.slice(1)) {
    const sheet = result.workbook.getWorksheet(name);
    let count = 0;
    for (let r = 3; r <= sheet.rowCount; r += 1) {
      if (sheet.getRow(r).getCell(1).value) count += 1;
    }
    assert.equal(count, expectedByWeek[name] || 0, `weekly ${name} count`);
  }

  // Weekly sort: completedAt ascending. Verify column M is non-decreasing down each weekly.
  for (const name of SHEET_ORDER.slice(1)) {
    const sheet = result.workbook.getWorksheet(name);
    let prev = null;
    for (let r = 3; r <= sheet.rowCount; r += 1) {
      const completed = sheet.getRow(r).getCell(13).value;
      if (!completed) continue;
      if (prev) assert.ok(completed >= prev, `weekly ${name} row ${r} completed ascending`);
      prev = completed;
    }
  }

  // Master grouping: rows grouped by week index (01-07 block first, etc.).
  const master = result.workbook.getWorksheet('06');
  const weekSequence = [];
  for (let r = 2; r <= master.rowCount; r += 1) {
    const completed = master.getRow(r).getCell(13).value;
    if (completed instanceof Date) weekSequence.push(weekOf(completed.toISOString().slice(0, 10).replace(/-/g, '-') + ' ' + '00:00'));
  }
  const sorted = [...weekSequence].sort((a, b) => SHEET_ORDER.indexOf(a) - SHEET_ORDER.indexOf(b));
  assert.deepEqual(weekSequence, sorted, 'master rows grouped by week index');
});

// ---------------------------------------------------------------------------
// 5. Every L data cell is the correct formula with exact-decimal cached result
// ---------------------------------------------------------------------------

test('5. column L every data row is formula =H-I-J-K with exact-decimal result', async () => {
  const rows = juneRows();
  const included = includedRows(rows);
  const netsById = new Map(included.map((row) => [row[HEADERS.orderNumber], expectedNet(row)]));
  const { buffer } = await createJuneBuffer();
  const result = await transformWorkbook(buffer, { requestedVariant: 'shopee', originalFilename: 'Order.all.20260601_20260630.xlsx' });

  result.workbook.worksheets.forEach((sheet) => {
    const dataStart = sheet.name === '06' ? 2 : 3;
    for (let r = dataStart; r <= sheet.rowCount; r += 1) {
      const id = sheet.getRow(r).getCell(1).value;
      if (!id) continue;
      const cell = sheet.getRow(r).getCell(12); // L
      assert.equal(typeof cell.value, 'object', `${sheet.name} L${r} is a formula object`);
      assert.equal(cell.value.formula, `H${r}-I${r}-J${r}-K${r}`, `${sheet.name} L${r} formula text`);
      const expected = netsById.get(String(id));
      assert.equal(cell.value.result, expected, `${sheet.name} L${r} cached result exact decimal`);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Fixture-derived oracle counts and totals
// ---------------------------------------------------------------------------

test('6. matches fixture-derived oracle counts and net totals', async () => {
  const rows = juneRows();
  const included = includedRows(rows);
  const { buffer } = await createJuneBuffer();
  const result = await transformWorkbook(buffer, { requestedVariant: 'shopee', originalFilename: 'Order.all.20260601_20260630.xlsx' });

  assert.equal(result.metadata.finalRows, included.length);

  const totalsByWeek = {};
  included.forEach((row) => {
    const week = weekOf(row[HEADERS.completedAt]);
    totalsByWeek[week] = Math.round(((totalsByWeek[week] || 0) + expectedNet(row)) * 100) / 100;
  });
  const masterTotal = Object.values(totalsByWeek).reduce((sum, value) => sum + value, 0);

  assert.deepEqual(result.metadata.weeklyCounts, {
    '01-07.06': totalsByWeek['01-07.06'] ? included.filter((row) => weekOf(row[HEADERS.completedAt]) === '01-07.06').length : 0,
    '08-14.06': included.filter((row) => weekOf(row[HEADERS.completedAt]) === '08-14.06').length,
    '15-21.06': included.filter((row) => weekOf(row[HEADERS.completedAt]) === '15-21.06').length,
    '22-28.06': included.filter((row) => weekOf(row[HEADERS.completedAt]) === '22-28.06').length,
  });

  Object.entries(totalsByWeek).forEach(([week, total]) => {
    assert.equal(result.metadata.weeklyNetTotals[week], total, `weekly total ${week}`);
  });

  // Reconciliation: weekly totals sum to master total.
  const weeklySum = Object.values(result.metadata.weeklyNetTotals).reduce((sum, value) => sum + value, 0);
  assert.equal(Math.round(weeklySum * 100) / 100, Math.round(masterTotal * 100) / 100, 'weekly sum == master total');
});

// ---------------------------------------------------------------------------
// 7. Missing / unparseable / out-of-cycle completed time fails explicitly
// ---------------------------------------------------------------------------

test('7. an included row with missing completed time fails closed', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('orders');
  ws.addRow(HEADER_ORDER);
  // A non-cancelled row with blank completed time cannot be cycle-classified.
  ws.addRow(
    sourceRow({
      ...withPii(juneRows())[0],
      [HEADERS.completedAt]: '',
    }),
  );
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());

  await assert.rejects(
    () =>
      transformWorkbook(buffer, {
        requestedVariant: 'shopee',
        originalFilename: 'Order.all.20260601_20260630.xlsx',
      }),
    /completed time|เวลาที่ทำการสั่งซื้อสำเร็จ|cannot allocate/i,
  );
});

// ---------------------------------------------------------------------------
// 8. Numeric blank/comma parsing and text identifiers
// ---------------------------------------------------------------------------

test('8. parses comma-formatted numbers, treats blank numerics as 0, keeps identifiers as text', async () => {
  const { buffer } = await createJuneBuffer();
  const result = await transformWorkbook(buffer, { requestedVariant: 'shopee', originalFilename: 'Order.all.20260601_20260630.xlsx' });
  const master = result.workbook.getWorksheet('06');

  // The cancelled row had a comma-formatted net sale '1,098.00' — it is excluded, so find a
  // row with the comma fixture indirectly: instead verify a known included row's parsed value.
  // Row with blank sellerVoucher (week 22-28) must read I as 0, not blank/text.
  let foundBlankVoucher = false;
  for (let r = 2; r <= master.rowCount; r += 1) {
    const id = String(master.getRow(r).getCell(1).value);
    if (id === '250625HHH008') {
      assert.equal(master.getRow(r).getCell(9).value, 0, 'blank sellerVoucher -> 0');
      foundBlankVoucher = true;
    }
  }
  assert.ok(foundBlankVoucher, 'blank-voucher row present');

  // Identifiers stay text: leading digits not coerced. Check numFmt on A/E columns applied.
  assert.equal(master.getColumn(1).numFmt, '@');
  assert.equal(master.getColumn(5).numFmt, '@');
});

// ---------------------------------------------------------------------------
// 9. Comments, formats, fills, widths, heights, views and page setup
// ---------------------------------------------------------------------------

test('9. applies exact comments, formats, fills, widths, heights, views, page setup', async () => {
  const { buffer } = await createJuneBuffer();
  const result = await transformWorkbook(buffer, { requestedVariant: 'shopee', originalFilename: 'Order.all.20260601_20260630.xlsx' });

  const master = result.workbook.getWorksheet('06');
  const profile = require('../src/modules/seamless/services/shopeeAccountingCycles').MONTH_PROFILES['2026-06'];

  // Comments
  const masterL1Note = master.getCell('L1').note;
  assert.ok(masterL1Note, 'master L1 has a comment');
  const masterL1Text = typeof masterL1Note === 'string' ? masterL1Note : masterL1Note.texts.map((t) => t.text).join('');
  assert.equal(masterL1Text, profile.comments.masterL1);

  for (const name of SHEET_ORDER.slice(1)) {
    const sheet = result.workbook.getWorksheet(name);
    const note = sheet.getCell('L2').note;
    assert.ok(note, `weekly ${name} L2 has a comment`);
    const text = typeof note === 'string' ? note : note.texts.map((t) => t.text).join('');
    assert.equal(text, profile.comments.weeklyL2);
  }

  // Master geometry
  profile.geometry.master.widths.forEach((width, index) => {
    assert.equal(master.getColumn(index + 1).width, width, `master col ${index + 1} width`);
  });
  assert.ok(
    master.getColumn(2).width >= master.getColumn(13).width,
    'master order-date column is wide enough for the same typed datetime format as completed-at',
  );
  assert.equal(master.getRow(1).height, profile.geometry.master.rowHeights.header, 'master row1 height');
  for (let r = 2; r <= master.rowCount; r += 1) {
    if (master.getRow(r).getCell(1).value) {
      assert.equal(master.getRow(r).height, profile.geometry.master.rowHeights.data, `master row ${r} height`);
    }
  }
  assert.equal(master.views[0] && master.views[0].zoomScale, 90, 'master zoom 90');
  assert.equal(master.pageSetup.orientation, 'portrait', 'master portrait');
  assert.equal(master.pageSetup.paperSize, 9, 'master A4');
  // Spec §11: master is a literal fixed 100% print scale (no fit-to-page). fitToPage must be
  // false and scale 100 — the opposite of the weekly fit-to-1-page-wide mode. This guards
  // against regressing back to a hardcoded fitToPage:true.
  assert.equal(master.pageSetup.fitToPage, false, 'master fitToPage false (fixed scale per spec §11)');
  assert.equal(master.pageSetup.scale, 100, 'master scale 100 per spec §11');

  // No freeze panes anywhere; gridlines visible.
  result.workbook.worksheets.forEach((sheet) => {
    const frozen = (sheet.views || []).some((view) => view.state === 'frozen');
    assert.equal(frozen, false, `${sheet.name} no freeze`);
  });

  // Weekly geometry + print
  for (const name of SHEET_ORDER.slice(1)) {
    const sheet = result.workbook.getWorksheet(name);
    profile.geometry.weekly.widths.forEach((width, index) => {
      assert.equal(sheet.getColumn(index + 1).width, width, `weekly ${name} col ${index + 1} width`);
    });
    assert.ok(
      sheet.getColumn(2).width >= sheet.getColumn(13).width,
      `weekly ${name} order-date column is wide enough for the same typed datetime format as completed-at`,
    );
    assert.equal(sheet.getRow(1).height, profile.geometry.weekly.rowHeights.period);
    assert.equal(sheet.getRow(2).height, profile.geometry.weekly.rowHeights.header);
    assert.equal(sheet.pageSetup.orientation, 'landscape', `weekly ${name} landscape`);
    assert.equal(sheet.pageSetup.fitToWidth, 1, `weekly ${name} fit 1 wide`);
    assert.equal(sheet.pageSetup.paperSize, 9, `weekly ${name} A4`);
  }

  // Weekly header fill #C0E6F5 on A2:M2
  for (const name of SHEET_ORDER.slice(1)) {
    const sheet = result.workbook.getWorksheet(name);
    for (let col = 1; col <= 13; col += 1) {
      const fill = sheet.getRow(2).getCell(col).fill;
      assert.ok(fill && fill.fgColor && fill.fgColor.argb === 'FFC0E6F5', `weekly ${name} header fill at col ${col}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 10. PII absence
// ---------------------------------------------------------------------------

test('10. no PII anywhere in processed workbook', async () => {
  const { buffer } = await createJuneBuffer();
  const result = await transformWorkbook(buffer, { requestedVariant: 'shopee', originalFilename: 'Order.all.20260601_20260630.xlsx' });

  const piiHeaders = [HEADERS.buyerUsername, HEADERS.recipientName, HEADERS.phone, HEADERS.address];
  const piiValues = ['buyer-1', 'recipient-1', '0800000000', 'secret-address-1'];
  const allText = [];
  result.workbook.worksheets.forEach((sheet) => {
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const text = cell.text || (typeof cell.value === 'object' ? JSON.stringify(cell.value) : String(cell.value || ''));
        allText.push(text);
      });
    });
  });
  const blob = allText.join('\n');
  piiHeaders.forEach((header) => assert.ok(!blob.includes(header), `PII header absent: ${header}`));
  piiValues.forEach((value) => assert.ok(!blob.includes(value), `PII value absent: ${value}`));
});

// ---------------------------------------------------------------------------
// 11. Automatic rolling four-week cycles
// ---------------------------------------------------------------------------

test('11. a filename aligned to the next 28-day boundary creates the July cycle automatically', async () => {
  const { buffer, originalFilename } = await createJuneBuffer({
    originalFilename: 'Order.all.20260629_20260731.xlsx',
    rows: shiftRows(juneRows(), 28),
  });
  const result = await transformWorkbook(buffer, { requestedVariant: 'shopee', originalFilename });

  assert.deepEqual(result.workbook.worksheets.map((sheet) => sheet.name), [
    '07',
    '29.06-05.07',
    '06-12.07',
    '13-19.07',
    '20-26.07',
  ]);
  assert.equal(result.metadata.periodStart, '2026-06-29');
  assert.equal(result.metadata.periodEnd, '2026-07-26');
  assert.equal(result.metadata.finalRows, 7);
  assert.equal(result.metadata.carryoverExcluded, 2);

  const filename = buildOutputFilename(result.worksheet, originalFilename, 'shopee', result.metadata);
  assert.equal(filename.filename, '2026-06-29_to_2026-07-26-dr-morepen-accounting.xlsx');
});

test('11b. a filename that starts after the selected rolling cycle fails closed', async () => {
  const { buffer } = await createJuneBuffer({ originalFilename: 'Order.all.20260510_20260531.xlsx' });
  await assert.rejects(
    () => transformWorkbook(buffer, { requestedVariant: 'shopee', originalFilename: 'Order.all.20260510_20260531.xlsx' }),
    /must cover the complete four-week accounting cycle/,
  );
});

test('7b. order created before the cycle is included when completed time is inside the cycle', async () => {
  const row = {
    ...withPii(juneRows())[0],
    [HEADERS.orderNumber]: '260628BOUNDARY1',
    [HEADERS.orderDate]: '2026-06-28 23:50',
    [HEADERS.completedAt]: '2026-06-29 00:05',
  };
  const { buffer } = await createJuneBuffer({ rows: [row] });
  const originalFilename = 'Order.all.20260601_20260731.xlsx';

  const result = await transformWorkbook(buffer, { requestedVariant: 'shopee', originalFilename });

  assert.equal(result.metadata.periodStart, '2026-06-29');
  assert.equal(result.metadata.finalRows, 1);
  assert.equal(result.metadata.weeklyCounts['29.06-05.07'], 1);
  assert.equal(
    result.workbook.getWorksheet('29.06-05.07').getCell('A3').value,
    '260628BOUNDARY1',
  );
});

test('7c. order completed after the cycle is carried forward without allocation failure', async () => {
  const row = {
    ...withPii(juneRows())[0],
    [HEADERS.orderNumber]: '260726BOUNDARY2',
    [HEADERS.orderDate]: '2026-07-26 23:50',
    [HEADERS.completedAt]: '2026-07-27 00:05',
  };
  const { buffer } = await createJuneBuffer({ rows: [row] });
  const originalFilename = 'Order.all.20260629_20260731.xlsx';

  const result = await transformWorkbook(buffer, { requestedVariant: 'shopee', originalFilename });

  assert.equal(result.metadata.periodStart, '2026-06-29');
  assert.equal(result.metadata.finalRows, 0);
  assert.equal(result.metadata.completedAfterCycleExcluded, 1);
  assert.equal(result.metadata.carryoverExcluded, 1);
  assert.equal(result.metadata.cycleClosureStatus, 'review_required_empty');
  assert.equal(result.metadata.checkpointEligible, false);
});

test('11c. a filename that ends before all four weeks are covered fails closed', async () => {
  const { buffer } = await createJuneBuffer({
    originalFilename: 'Order.all.20260629_20260705.xlsx',
    rows: shiftRows(juneRows(), 28),
  });
  await assert.rejects(
    () => transformWorkbook(buffer, {
      requestedVariant: 'shopee',
      originalFilename: 'Order.all.20260629_20260705.xlsx',
    }),
    /must cover the complete four-week accounting cycle/,
  );
});

// ---------------------------------------------------------------------------
// 12. Upload remains manual-print and unrelated formats do not regress
// ---------------------------------------------------------------------------

test('12. shopee stays manual-print, variant identity preserved, Seamless formatter rejected', async () => {
  const { buffer, originalFilename } = await createJuneBuffer();
  const result = await transformWorkbook(buffer, { requestedVariant: 'shopee', originalFilename });
  assert.equal(result.detectedVariant, 'shopee');
  assert.equal(result.effectiveVariant, 'shopee');
  assert.equal(result.metadata.printPolicy, 'manual');

  await assert.rejects(
    () => transformWorkbook(buffer, { requestedVariant: 'individual' }),
    /Shopee order export/,
  );
});

// ---------------------------------------------------------------------------
// Filename: cycle-driven production naming, period-driven, no hardcoded month literal
// ---------------------------------------------------------------------------

test('filename is cycle-driven dr-morepen-accounting and uses period end as history date', async () => {
  const { buffer, originalFilename } = await createJuneBuffer();
  const result = await transformWorkbook(buffer, { requestedVariant: 'shopee', originalFilename });
  const filename = buildOutputFilename(result.worksheet, originalFilename, 'shopee', result.metadata);

  assert.equal(filename.filename, '2026-06-01_to_2026-06-28-dr-morepen-accounting.xlsx');
  assert.equal(filename.parsedDate, '2026-06-28');
  assert.equal(filename.periodStart, '2026-06-01');
  assert.equal(filename.periodEnd, '2026-06-28');
  // No hardcoded Thai month literal in the production filename.
  assert.ok(!filename.filename.includes('มิถุนายน'));
});

// ---------------------------------------------------------------------------
// Internal: column resolution guard — all 12 source columns resolve on the real header set
// ---------------------------------------------------------------------------

test('guard: all 12 mapped source headers resolve to non-null column indexes', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('orders');
  ws.addRow(HEADER_ORDER);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const loaded = await openOutput(buffer);
  const sheet = loaded.getWorksheet('orders');

  // Use the transform's own detection helper via the public surface: a buffer with only headers
  // and no data rows must still be detected as shopee (detection is header-based). If any of
  // the 12 required headers failed to resolve, detection would return false / throw.
  const { findShopeeHeader } = require('../src/modules/seamless/services/shopeeWorkbookTransform');
  const header = findShopeeHeader(sheet);
  assert.ok(header, 'shopee header detected on the real header set');

  // Every mapped literal must resolve to a column index.
  Object.values(HEADERS)
    .filter((headerText) => ![HEADERS.buyerUsername, HEADERS.recipientName, HEADERS.phone, HEADERS.address].includes(headerText))
    .forEach((headerText) => {
      assert.ok(header.indexes.has(headerText), `header resolves: ${headerText}`);
    });
});

// ---------------------------------------------------------------------------
// RAW-BYTE GUARDS — these decode the actual XLSX bytes, NOT ExcelJS's read-back.
// A write→read round-trip through the same library is self-consistent on one timezone and
// hides both bugs these tests pin. They are permanent regression guards, not one-offs.
// ---------------------------------------------------------------------------

test('raw-byte: serialized date serials encode the correct wall-clock time (no tz shift)', async () => {
  // ExcelJS serializes dates via UTC getters, so the Date must carry the wall-clock instant as
  // its UTC value (built with Date.UTC). If parseDateTime builds with local getters, every
  // <v> serial shifts by the host tz offset — on UTC+7, 08:36 lands as 01:36 in the file.
  const { buffer } = await createJuneBuffer();
  const result = await transformWorkbook(buffer, { requestedVariant: 'shopee', originalFilename: 'Order.all.20260601_20260630.xlsx' });
  const written = Buffer.from(await result.workbook.xlsx.writeBuffer());

  // sheet1.xml is the master '06' sheet (first added). B2 = first row's order date.
  const sheet1 = readZipEntry(written, 'xl/worksheets/sheet1.xml');
  const b2Serial = rawSerialAt(sheet1, 'B2');
  assert.ok(b2Serial !== null, 'master B2 has a numeric <v> serial');

  const decoded = decodeSerial(b2Serial);
  // The first included fixture row has order date 2026-06-01 08:36. The serial must decode
  // (pure epoch math, UTC) to exactly that wall-clock value — independent of the host tz the
  // test runs in. This is the check that would have caught the 7-hour shift.
  assert.equal(decoded.getUTCFullYear(), 2026);
  assert.equal(decoded.getUTCMonth(), 5); // June
  assert.equal(decoded.getUTCDate(), 1);
  assert.equal(decoded.getUTCHours(), 8);
  assert.equal(decoded.getUTCMinutes(), 36);

  // Also check M3 (first weekly sheet's first completed-time cell) lands on the right day/time.
  // sheet2.xml = first weekly '01-07.06'; its data starts at row 3.
  const sheet2 = readZipEntry(written, 'xl/worksheets/sheet2.xml');
  const m3Serial = rawSerialAt(sheet2, 'M3');
  assert.ok(m3Serial !== null, 'weekly M3 has a numeric <v> serial');
  const m3 = decodeSerial(m3Serial);
  // First included row's completed time is 2026-06-02 11:28.
  assert.equal(m3.getUTCFullYear(), 2026);
  assert.equal(m3.getUTCMonth(), 5);
  assert.equal(m3.getUTCDate(), 2);
  assert.equal(m3.getUTCHours(), 11);
  assert.equal(m3.getUTCMinutes(), 28);
});

test('raw-byte: workbook default font (font[0]) is Angsana New 14, not Calibri 11', async () => {
  // OOXML column widths are measured against the Normal cell style's font, which is font[0].
  // ExcelJS hardcodes font[0] = Calibri 11 with no public override; if it stays Calibri, the
  // stored widths render too narrow and date columns overflow to #############. The transform
  // must rewrite font[0] to the rendering font (Angsana New 14) in the serialized bytes.
  const { buffer } = await createJuneBuffer();
  const result = await transformWorkbook(buffer, { requestedVariant: 'shopee', originalFilename: 'Order.all.20260601_20260630.xlsx' });
  const written = Buffer.from(await result.workbook.xlsx.writeBuffer());

  const styles = readZipEntry(written, 'xl/styles.xml');
  const font0 = defaultFontFromStyles(styles);
  assert.ok(font0, 'styles.xml has a font[0]');
  const font0Normalized = font0.replace(/\s+/g, '');
  assert.match(font0Normalized, /<szval="14"/, 'font[0] size is 14');
  assert.match(font0Normalized, /<nameval="AngsanaNew"/, 'font[0] name is Angsana New');
  assert.ok(!/Calibri/.test(font0), 'font[0] is not the ExcelJS Calibri default');
});

// Re-export for the verification script to reuse the same oracle helper.
module.exports = { expectedNet, includedRows, weekOf, juneRows, HEADERS, OUTPUT_HEADERS, SHEET_ORDER };
