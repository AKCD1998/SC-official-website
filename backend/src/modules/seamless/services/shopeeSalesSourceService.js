const crypto = require('node:crypto');
const path = require('node:path');
const { moneyCents } = require('./shopeeSalesAccounting');
const { requireShopeeShopCode } = require('./shopeeShops');
const { sanitizeShopeeOrderItem } = require('../shopeeOrderValidation');

const HEADERS = Object.freeze({
  orderNumber: 'หมายเลขคำสั่งซื้อ', status: 'สถานะการสั่งซื้อ',
  orderedAt: 'วันที่ทำการสั่งซื้อ', paidAt: 'เวลาการชำระสินค้า',
  name: 'ชื่อสินค้า', variant: 'ชื่อตัวเลือก',
  quantity: 'จำนวน', unitPrice: 'ราคาขาย', itemSubtotal: 'ราคาขายสุทธิ',
  shopeeProductDiscount: 'ส่วนลดจาก Shopee', sellerVoucher: 'โค้ดส่วนลดชำระโดยผู้ขาย',
  voucherCodes: 'โค้ดส่วนลด',
  completedAt: 'เวลาที่ทำการสั่งซื้อสำเร็จ',
});

function text(value) {
  if (value && typeof value === 'object') throw new Error('Formula/rich-text source cells are not supported.');
  // NFKC decomposes Thai sara-am (ำ), so use NFC for exact Thai labels.
  return String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function parseBangkokDate(value, label = 'Shopee date') {
  const raw = value instanceof Date ? value.toISOString().slice(0, 19).replace('T', ' ') : text(value);
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::(\d{2}))?$/u.exec(raw);
  if (!match) throw new Error(`Invalid ${label}.`);
  const clock = `${match[1]}T${match[2]}:${match[3] || '00'}`;
  const instant = new Date(`${clock}+07:00`);
  const roundTrip = new Date(instant.getTime() + 7 * 3600000).toISOString().slice(0, 19);
  if (roundTrip !== clock) throw new Error(`Invalid ${label} calendar date.`);
  return instant.toISOString();
}

function parseOptionalBangkokDate(value, label) {
  const normalized = text(value);
  if (!normalized || normalized === '-') return null;
  return parseBangkokDate(value, label);
}

function classifyStatus(value) {
  const status = text(value);
  if (status === 'ยกเลิกแล้ว') return { status, excluded: true };
  // Delivered orders contain explanatory return-policy text. Never classify an
  // actual return by searching the entire string for คืนเงิน/คืนสินค้า.
  if (/^(สำเร็จแล้ว|จัดส่งสำเร็จแล้ว|ผู้ซื้อได้รับสินค้าแล้ว|กำลังจัดส่ง|การจัดส่ง|ที่ต้องจัดส่ง|ยังไม่ชำระเงิน|ยังไม่ชำระ)(?:$|\s)/u.test(status)) {
    return { status, excluded: false };
  }
  throw new Error(`Unsupported Shopee order status: ${status.slice(0, 100)}`);
}

function readCents(value, label) {
  const raw = typeof value === 'number' ? String(value) : text(value);
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/u.test(raw)) {
    throw new Error(`Missing or invalid ${label}.`);
  }
  const clean = raw.replace(/,/gu, '');
  const cents = moneyCents(clean);
  if (cents === null) throw new Error(`Missing or invalid ${label}.`);
  return cents;
}

function parseVoucherCodes(value) {
  const raw = text(value);
  if (!raw || raw === '-') return [];
  const codes = [...new Set(raw.split(/[;,]/u).map((part) => part.trim().toUpperCase()).filter(Boolean))].sort();
  if (!codes.length || codes.length > 20
    || codes.some((code) => !/^[A-Z0-9][A-Z0-9._-]{1,79}$/u.test(code))) {
    throw new Error('Invalid Shopee voucher code list.');
  }
  return codes;
}

function parseSalesSourceRows(rows, { shopCode, sourceFilename, sourceSha256, observedAt }) {
  requireShopeeShopCode(shopCode);
  if (!/^[a-f0-9]{64}$/u.test(sourceSha256 || '')) throw new Error('Source SHA-256 is required.');
  const observed = new Date(observedAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(observedAt || '') || Number.isNaN(observed.getTime())) {
    throw new Error('Explicit ISO snapshot observation time with timezone is required.');
  }
  // Date() normalizes impossible calendar dates such as September 31. Reject
  // those before they can silently alter snapshot precedence.
  parseBangkokDate(observedAt.slice(0, 19).replace('T', ' '));
  const filename = path.basename(sourceFilename);
  const period = /^Order\.all\.(\d{4})(\d{2})(\d{2})_(\d{4})(\d{2})(\d{2})(?:\(\d+\)| \(\d+\))?\.xlsx$/iu.exec(filename);
  if (!period) throw new Error('Expected an original Order.all.YYYYMMDD_YYYYMMDD.xlsx filename.');
  const startDate = `${period[1]}-${period[2]}-${period[3]}`;
  const endDate = `${period[4]}-${period[5]}-${period[6]}`;
  parseBangkokDate(`${startDate} 00:00`);
  parseBangkokDate(`${endDate} 00:00`);
  if (startDate > endDate) throw new Error('Invalid source period.');
  const headers = (rows[0] || []).map(text);
  const columns = Object.fromEntries(Object.entries(HEADERS).map(([key, header]) => {
    const indices = headers.flatMap((value, index) => value === header ? [index] : []);
    if (indices.length !== 1) throw new Error(`Missing/duplicate header: ${header}`);
    return [key, indices[0]];
  }));
  const orders = new Map();
  rows.slice(1).forEach((row, index) => {
    if (row.every((value) => value === null || value === undefined || value === '')) return;
    const get = (key) => row[columns[key]];
    const id = text(get('orderNumber')).toUpperCase();
    if (!/^[A-Z0-9]{8,40}$/u.test(id)) throw new Error(`Invalid order number at row ${index + 2}.`);
    const orderedAt = parseBangkokDate(get('orderedAt'));
    const paidAt = parseOptionalBangkokDate(get('paidAt'), 'Shopee payment date');
    const completedAt = parseOptionalBangkokDate(get('completedAt'), 'Shopee completed date');
    const thaiDate = new Date(new Date(orderedAt).getTime() + 7 * 3600000).toISOString().slice(0, 10);
    if (thaiDate < startDate || thaiDate > endDate || [orderedAt, paidAt, completedAt]
      .filter(Boolean).some((value) => new Date(value) > observed)) {
      throw new Error(`Order creation date is outside the source period/snapshot: ${id}`);
    }
    if (paidAt && new Date(paidAt) < new Date(orderedAt)) {
      throw new Error(`Shopee payment date precedes order creation: ${id}`);
    }
    if (completedAt && new Date(completedAt) < new Date(orderedAt)) {
      throw new Error(`Shopee completed date precedes order creation: ${id}`);
    }
    const status = classifyStatus(get('status'));
    const sellerVoucherCents = readCents(get('sellerVoucher'), 'seller voucher');
    const voucherCodes = parseVoucherCodes(get('voucherCodes'));
    const quantity = Number(get('quantity'));
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error(`Invalid quantity: ${id}`);
    const name = text(get('name'));
    if (!name) throw new Error(`Missing product name: ${id}`);
    let order = orders.get(id);
    if (!order) {
      order = { shopCode, orderNumber: id, orderedAt, paidAt, completedAt, ...status,
        subtotalCents: 0, sellerVoucherCents, discountCents: 0, voucherCodes, items: [], sourceRows: [] };
      orders.set(id, order);
    } else if (order.status !== status.status || order.orderedAt !== orderedAt
      || order.paidAt !== paidAt || order.completedAt !== completedAt
      || order.sellerVoucherCents !== sellerVoucherCents
      || JSON.stringify(order.voucherCodes) !== JSON.stringify(voucherCodes)) {
      throw new Error(`Inconsistent order-level date/status/voucher: ${id}`);
    }
    order.subtotalCents += readCents(get('itemSubtotal'), 'net sale');
    order.discountCents += readCents(get('shopeeProductDiscount'), 'Shopee product discount');
    const item = { name, variant: text(get('variant')), quantity, unitPrice: readCents(get('unitPrice'), 'unit price') / 100 };
    const safeItem = sanitizeShopeeOrderItem(item);
    if (!safeItem || safeItem.name !== item.name || safeItem.variant !== item.variant || order.items.length >= 100) {
      throw new Error(`Source product fields exceed the privacy/size contract: ${id}`);
    }
    order.items.push(safeItem);
    order.sourceRows.push(index + 2);
  });
  const facts = [...orders.values()].map(({ subtotalCents, sellerVoucherCents, discountCents, ...order }) => {
    if (![subtotalCents, sellerVoucherCents, discountCents].every(Number.isSafeInteger) || sellerVoucherCents > subtotalCents) {
      throw new Error(`Invalid financial components: ${order.orderNumber}`);
    }
    return { ...order, itemSubtotal: subtotalCents / 100, sellerVoucher: sellerVoucherCents / 100, shopeeProductDiscount: discountCents / 100 };
  });
  return { shopCode, sourceFilename: filename, sourceSha256, observedAt: observed.toISOString(), startDate, endDate, facts };
}

async function readSalesSourceBuffer(buffer, {
  shopCode,
  observedAt,
  sourceFilename,
  sourceSha256 = null,
}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Original orders workbook buffer is required.');
  const computedSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (sourceSha256 && sourceSha256 !== computedSha256) throw new Error('Source SHA-256 does not match workbook bytes.');
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet('orders');
  if (!sheet) throw new Error('Original orders worksheet is required.');
  const rows = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    rows.push(Array.from({ length: sheet.columnCount }, (_, i) => row.getCell(i + 1).value));
  });
  return parseSalesSourceRows(rows, {
    shopCode,
    observedAt,
    sourceFilename,
    sourceSha256: computedSha256,
  });
}

async function readSalesSource(filePath, { shopCode, observedAt }) {
  const fs = require('node:fs/promises');
  const buffer = await fs.readFile(filePath);
  return readSalesSourceBuffer(buffer, {
    shopCode,
    observedAt,
    sourceFilename: path.basename(filePath),
  });
}

module.exports = {
  HEADERS,
  classifyStatus,
  parseBangkokDate,
  parseOptionalBangkokDate,
  parseVoucherCodes,
  parseSalesSourceRows,
  readSalesSource,
  readSalesSourceBuffer,
};
