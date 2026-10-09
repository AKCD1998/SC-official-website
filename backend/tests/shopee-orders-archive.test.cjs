const crypto = require('node:crypto');
const ExcelJS = require('exceljs');
const { zipSync } = require('fflate');
const { HEADERS, readSalesSourceBuffer } = require('../src/modules/seamless/services/shopeeSalesSourceService');

const archiveFilename = 'Order.all.20260908_20260908.zip';
const partFilename = (part, total) => `Order.all.20260908_20260908_part_${part}_of_${total}.xlsx`;
const options = { shopCode: 'sc-drug-store', observedAt: '2026-09-09T06:00:00.000Z', sourceFilename: archiveFilename };
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
async function workbook(orderNumber = 'TESTORDER001', net = 90) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('orders');
  sheet.addRow(Object.values(HEADERS));
  sheet.addRow([orderNumber, 'สำเร็จแล้ว', '2026-09-08 12:00', '2026-09-08 12:01',
    'สินค้าทดสอบ', 'หนึ่งกล่อง', 1, 100, net, 5, 10, 'VOUCHER-001', '2026-09-08 18:00']);
  return Buffer.from(await book.xlsx.writeBuffer());
}
const archive = (entries) => Buffer.from(zipSync(entries));

test('native multipart ZIP retains outer identity and each original workbook/row/financial cell', async () => {
  const first = await workbook();
  const second = await workbook('TESTORDER002', 80);
  const bytes = archive({ [partFilename(2, 2)]: second, [partFilename(1, 2)]: first });
  const source = await readSalesSourceBuffer(bytes, { ...options, sourceSha256: hash(bytes) });
  expect(source.sourceFilename).toBe(archiveFilename);
  expect(source.sourceSha256).toBe(hash(bytes));
  expect(source.facts.map((fact) => fact.itemSubtotal)).toEqual([90, 80]);
  expect(source.memberSources.map((member) => member.sourceFilename)).toEqual([partFilename(1, 2), partFilename(2, 2)]);
  expect(source.memberSources.map((member) => member.sourceSha256)).toEqual([hash(first), hash(second)]);
  expect(source.archiveMembers).toEqual([
    { originalFilename: partFilename(1, 2), sha256: hash(first), bytes: first.length, part: 1, totalParts: 2, orderCount: 1 },
    { originalFilename: partFilename(2, 2), sha256: hash(second), bytes: second.length, part: 2, totalParts: 2, orderCount: 1 },
  ]);
  expect(source.facts[0]).toMatchObject({ sourceRows: [2], items: [{ quantity: 1, unitPrice: 100 }],
    lineFinancials: [{ netSale: 90, shopeeProductDiscount: 5 }], sellerVoucher: 10, voucherCodes: ['VOUCHER-001'] });
});

test.each([
  ['wrong period', 'Order.all.20260907_20260908_part_1_of_1.xlsx', /filename\/period/],
  ['missing part', partFilename(1, 2), /sequence/],
  ['wrong sequence', partFilename(2, 1), /sequence/],
  ['path', `../${partFilename(1, 1)}`, /Unsafe/],
  ['unrelated file', 'other.xlsx', /filename\/period/],
])('rejects %s before interpreting source rows', async (_label, name, reason) => {
  const bytes = archive({ [name]: await workbook() });
  await expect(readSalesSourceBuffer(bytes, options)).rejects.toThrow(reason);
});

test('rejects duplicate/split order across parts rather than importing a partial order', async () => {
  const bytes = archive({ [partFilename(1, 2)]: await workbook(), [partFilename(2, 2)]: await workbook() });
  await expect(readSalesSourceBuffer(bytes, options)).rejects.toThrow(/duplicate or split orders/);
});

test('rejects bad financial cells in any part and wrong outer hash', async () => {
  const bytes = archive({ [partFilename(1, 2)]: await workbook(), [partFilename(2, 2)]: await workbook('TESTORDER002', '-') });
  await expect(readSalesSourceBuffer(bytes, options)).rejects.toThrow(/net sale/);
  await expect(readSalesSourceBuffer(bytes, { ...options, sourceSha256: '0'.repeat(64) })).rejects.toThrow(/SHA-256/);
});

test('rejects empty archives, fake workbooks and nested expansion bombs', async () => {
  await expect(readSalesSourceBuffer(archive({}), options)).rejects.toThrow(/empty/);
  await expect(readSalesSourceBuffer(archive({ [partFilename(1, 1)]: archive({ 'other.txt': Buffer.from('other') }) }), options))
    .rejects.toThrow(/not an XLSX/);
  const bomb = archive({ 'xl/workbook.xml': new Uint8Array(81 * 1024 * 1024) });
  await expect(readSalesSourceBuffer(archive({ [partFilename(1, 1)]: bomb }), options))
    .rejects.toThrow(/structure limits/);
});
