const crypto = require('node:crypto');
const path = require('node:path');
const { moneyCents } = require('./shopeeSalesAccounting');
const { parseBangkokDate } = require('./shopeeSalesSourceService');
const { requireShopeeShopCode, requireShopeeShopScope, SHOPEE_SHOP_PROFILES } = require('./shopeeShops');

const SHEET = 'ยืนยันแล้ว';
const HEADERS = Object.freeze({ date: 'วันที่', salesTotal: 'ยอดขายทั้งหมด (THB)',
  orderCount: 'คำสั่งซื้อทั้งหมด', cancelledOrderCount: 'คำสั่งซื้อที่ยกเลิก', cancelledSales: 'ยอดขายที่ยกเลิก',
  returnedOrderCount: 'คำสั่งซื้อที่คืนเงิน/คืนสินค้า', returnedSales: 'ยอดขายที่คืนเงิน/คืนสินค้า' });
const METRICS = ['salesTotal', 'orderCount', 'cancelledOrderCount', 'cancelledSales', 'returnedOrderCount', 'returnedSales'];
function text(value) {
  if (value && typeof value === 'object') throw new Error('Formula/rich-text statistics cells are not supported.');
  return String(value ?? '').normalize('NFC').trim();
}
function isoDate(value) {
  const date = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error('A valid ISO report date is required.');
  parseBangkokDate(`${date} 00:00:00`);
  return date;
}
function datesInRange(start, end) {
  isoDate(start); isoDate(end);
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000 + 1;
  if (!Number.isInteger(days) || days < 1 || days > 3660) throw new Error('Unsupported report date range.');
  return Array.from({ length: days }, (_, i) => new Date(Date.parse(`${start}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));
}
function readMetric(value, key) {
  const raw = text(value);
  const count = key.endsWith('Count');
  if (!(count ? /^(?:\d+|\d{1,3}(?:,\d{3})+)$/u : /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/u).test(raw)) {
    throw new Error(`Missing or invalid confirmed ${key}.`);
  }
  const result = count ? Number(raw.replace(/,/gu, '')) : moneyCents(raw.replace(/,/gu, ''));
  if (!Number.isSafeInteger(result)) throw new Error(`Invalid confirmed ${key} precision.`);
  return result;
}
function metricsFrom(row, columns) {
  const amounts = Object.fromEntries(METRICS.map(key => [key, readMetric(row[columns[key]], key)]));
  if (amounts.cancelledSales > amounts.salesTotal || amounts.cancelledOrderCount > amounts.orderCount) {
    throw new Error('Confirmed cancellations exceed the confirmed population.');
  }
  return amounts;
}
function amountUnits(amounts) {
  return Object.fromEntries(METRICS.map(key => [key, key.endsWith('Count') ? amounts[key] : amounts[key] / 100]));
}

function parseConfirmedSalesRows(rows, { shopCode, sourceFilename, sourceSha256, observedAt }) {
  shopCode = requireShopeeShopCode(shopCode);
  const filename = path.basename(sourceFilename);
  const match = /^([a-z0-9]+)\.shopee-shop-stats\.(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})(?: ?\(\d+\))?\.xlsx$/iu.exec(filename);
  if (!match || match[1] !== SHOPEE_SHOP_PROFILES[shopCode].statisticsUsername) throw new Error('Statistics filename does not identify the selected shop.');
  const startDate = `${match[2]}-${match[3]}-${match[4]}`;
  const endDate = `${match[5]}-${match[6]}-${match[7]}`;
  const expectedDates = datesInRange(startDate, endDate);
  if (!/^[a-f0-9]{64}$/u.test(sourceSha256 || '')) throw new Error('Source SHA-256 is required.');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(observedAt || '')
    || Number.isNaN(Date.parse(observedAt))) throw new Error('Explicit ISO observation time with timezone is required.');
  parseBangkokDate(observedAt.slice(0, 19).replace('T', ' '));
  // Only complete historical report days are accepted, not an in-progress day.
  if (Date.parse(`${endDate}T23:59:59+07:00`) > Date.parse(observedAt)) throw new Error('Report period has not finished at the observation time.');
  const headers = (rows[0] || []).map(text);
  const columns = Object.fromEntries(Object.entries(HEADERS).map(([key, header]) => {
    const indices = headers.flatMap((item, i) => item === header ? [i] : []);
    if (indices.length !== 1) throw new Error(`Missing/duplicate confirmed header: ${header}`);
    return [key, indices[0]];
  }));
  const displayDate = value => value.split('-').reverse().join('-');
  if (text(rows[1]?.[columns.date]) !== `${displayDate(startDate)}-${displayDate(endDate)}`) throw new Error('Statistics summary period does not match the filename.');
  if ((rows[2] || []).some(value => text(value))) throw new Error('Unexpected statistics spacer content.');
  for (const [key, header] of Object.entries(HEADERS)) {
    if (text(rows[3]?.[columns[key]]) !== header) throw new Error('Missing repeated daily headers.');
  }
  const control = metricsFrom(rows[1], columns);
  const totals = Object.fromEntries(METRICS.map(key => [key, 0]));
  const seen = new Set();
  const facts = rows.slice(4).flatMap((row, index) => {
    if (row.every(value => !text(value))) return [];
    const rawDate = text(row[columns.date]);
    if (!/^\d{2}-\d{2}-\d{4}$/u.test(rawDate)) throw new Error('Invalid daily statistics date.');
    const date = isoDate(rawDate.split('-').reverse().join('-'));
    if (seen.has(date) || date < startDate || date > endDate) throw new Error('Duplicate/out-of-period statistics day.');
    seen.add(date);
    const amounts = metricsFrom(row, columns);
    for (const key of METRICS) totals[key] += amounts[key];
    return [{ shopCode, date, ...amountUnits(amounts), sourceRow: index + 5 }];
  }).sort((a, b) => a.date.localeCompare(b.date));
  if (expectedDates.some(date => !seen.has(date))) throw new Error('Statistics daily coverage is incomplete.');
  for (const key of METRICS) {
    if (!Number.isSafeInteger(totals[key]) || totals[key] !== control[key]) throw new Error(`Confirmed daily/summary mismatch: ${key}`);
  }
  return { shopCode, sourceFilename: filename, sourceSha256, observedAt: new Date(observedAt).toISOString(),
    startDate, endDate, sheetName: SHEET, control: amountUnits(control), facts };
}

async function readConfirmedSalesSourceBuffer(buffer, {
  sourceFilename,
  sourceSha256 = null,
  ...options
}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Original statistics workbook buffer is required.');
  const computedSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (sourceSha256 && sourceSha256 !== computedSha256) throw new Error('Source SHA-256 does not match workbook bytes.');
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet(SHEET);
  if (!sheet) throw new Error('Original ยืนยันแล้ว worksheet is required; other tabs are not substitutes.');
  const rows = [];
  sheet.eachRow({ includeEmpty: true }, row => rows.push(Array.from({ length: sheet.columnCount }, (_, i) => row.getCell(i + 1).value)));
  return parseConfirmedSalesRows(rows, {
    ...options,
    sourceFilename,
    sourceSha256: computedSha256,
  });
}

async function readConfirmedSalesSource(filePath, options) {
  const fs = require('node:fs/promises');
  const buffer = await fs.readFile(filePath);
  return readConfirmedSalesSourceBuffer(buffer, {
    ...options,
    sourceFilename: path.basename(filePath),
  });
}

function summarizeConfirmedSales(rows, { shopCode, startDate, endDate }) {
  const scope = requireShopeeShopScope(shopCode);
  const shops = scope === 'all' ? Object.keys(SHOPEE_SHOP_PROFILES) : [scope];
  const dates = datesInRange(startDate, endDate);
  const keys = new Set();
  for (const row of rows) {
    const key = `${row.shopCode}:${row.date}`;
    if (!shops.includes(row.shopCode) || !dates.includes(row.date) || keys.has(key)) throw new Error('Invalid confirmed summary scope or duplicate day.');
    METRICS.forEach(metric => readMetric(row[metric], metric));
    keys.add(key);
  }
  const summarizeEvidence = selected => {
    const sources = new Map();
    for (const row of selected) {
      const values = [row.sourceFilename, row.sourceSha256, row.observedAt];
      if (values.every(value => value == null)) continue;
      if (values.some(value => value == null) || !/^[a-f0-9]{64}$/u.test(row.sourceSha256)) {
        throw new Error('Invalid confirmed source evidence.');
      }
      const observedAt = new Date(row.observedAt);
      const importedAt = row.importedAt == null ? null : new Date(row.importedAt);
      if (Number.isNaN(observedAt.getTime()) || (importedAt && Number.isNaN(importedAt.getTime()))) {
        throw new Error('Invalid confirmed source evidence timestamp.');
      }
      const evidenceKey = `${row.shopCode}:${row.sourceSha256}`;
      const evidence = sources.get(evidenceKey) || {
        shopCode: row.shopCode,
        sourceFilename: row.sourceFilename,
        sourceSha256: row.sourceSha256,
        observedAt: observedAt.toISOString(),
        importedAt: importedAt?.toISOString() || null,
        coveredDates: new Set(),
      };
      if (evidence.sourceFilename !== row.sourceFilename || evidence.observedAt !== observedAt.toISOString()
        || evidence.importedAt !== (importedAt?.toISOString() || null)) {
        throw new Error('Conflicting confirmed source evidence.');
      }
      evidence.coveredDates.add(row.date);
      sources.set(evidenceKey, evidence);
    }
    const evidence = [...sources.values()].map(source => {
      const coveredDates = [...source.coveredDates].sort();
      return { shopCode: source.shopCode, sourceFilename: source.sourceFilename,
        sourceSha256: source.sourceSha256, observedAt: source.observedAt, importedAt: source.importedAt,
        coveredStartDate: coveredDates[0],
        coveredEndDate: coveredDates.at(-1), coveredDays: coveredDates.length };
    }).sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.sourceFilename.localeCompare(b.sourceFilename));
    return {
      latestDataDate: selected.map(row => row.date).sort().at(-1) || null,
      latestObservedAt: evidence[0]?.observedAt || null,
      latestImportedAt: evidence.filter(source => source.importedAt).map(source => source.importedAt).sort().at(-1) || null,
      sources: evidence,
    };
  };
  const summarize = selectedShops => {
    const selected = rows.filter(row => selectedShops.includes(row.shopCode));
    const missingDays = selectedShops.flatMap(shop => dates.filter(date => !keys.has(`${shop}:${date}`)).map(date => ({ shopCode: shop, date })));
    const result = { status: missingDays.length ? 'incomplete' : 'source_backed', coveredDays: selected.length,
      expectedDays: dates.length * selectedShops.length, missingDays };
    for (const key of METRICS) {
      const sum = selected.reduce((total, row) => total + readMetric(row[key], key), 0);
      if (!Number.isSafeInteger(sum)) throw new Error('Confirmed total exceeds precision.');
      result[key] = missingDays.length ? null : key.endsWith('Count') ? sum : sum / 100;
    }
    result.salesAfterCancellation = missingDays.length ? null : (moneyCents(result.salesTotal) - moneyCents(result.cancelledSales)) / 100;
    return { ...result, ...summarizeEvidence(selected) };
  };
  return { metric: 'shopee_confirmed_gross_sales', currency: 'THB', dateBasis: 'confirmed_report_date',
    sourceSheet: SHEET, startDate, endDate, ...summarize(shops),
    shops: shops.map(code => ({ shopCode: code, ...summarize([code]) })),
    daily: [...rows].sort((a, b) => a.shopCode.localeCompare(b.shopCode) || a.date.localeCompare(b.date)) };
}

async function getConfirmedSalesSummary(filters) {
  const { listConfirmedSalesDays } = require('../db/shopeeConfirmedSalesRepository');
  return summarizeConfirmedSales(await listConfirmedSalesDays(filters), filters);
}

module.exports = { HEADERS, SHEET, METRICS, datesInRange, parseConfirmedSalesRows, readConfirmedSalesSource,
  readConfirmedSalesSourceBuffer, summarizeConfirmedSales, getConfirmedSalesSummary };
