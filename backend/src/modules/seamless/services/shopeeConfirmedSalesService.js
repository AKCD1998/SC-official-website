const crypto = require('node:crypto');
const path = require('node:path');
const { moneyCents } = require('./shopeeSalesAccounting');
const { parseBangkokDate } = require('./shopeeSalesSourceService');
const { requireShopeeShopCode, requireShopeeShopScope, SHOPEE_SHOP_PROFILES } = require('./shopeeShops');

const SHEET = 'ยืนยันแล้ว';
const OVERVIEW_SHEET = 'ภาพรวมยอดขาย';
const HEADERS = Object.freeze({ date: 'วันที่', salesTotal: 'ยอดขายทั้งหมด (THB)',
  orderCount: 'คำสั่งซื้อทั้งหมด', cancelledOrderCount: 'คำสั่งซื้อที่ยกเลิก', cancelledSales: 'ยอดขายที่ยกเลิก',
  returnedOrderCount: 'คำสั่งซื้อที่คืนเงิน/คืนสินค้า', returnedSales: 'ยอดขายที่คืนเงิน/คืนสินค้า' });
const OVERVIEW_HEADERS = Object.freeze({
  date: 'วันที่',
  salesTotal: 'ยอดขาย (คำสั่งซื้อที่ได้รับการยืนยัน) (THB)',
  orderCount: 'คำสั่งซื้อ(ได้รับการยืนยัน)',
});
const PRIMARY_METRICS = ['salesTotal', 'orderCount'];
const OPTIONAL_METRICS = ['cancelledOrderCount', 'cancelledSales', 'returnedOrderCount', 'returnedSales'];
const METRICS = [...PRIMARY_METRICS, ...OPTIONAL_METRICS];
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
function readMetric(value, key, { nullable = false } = {}) {
  const raw = text(value);
  if (nullable && raw === '') return null;
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
  return Object.fromEntries(METRICS.map(key => [key,
    amounts[key] == null ? null : key.endsWith('Count') ? amounts[key] : amounts[key] / 100]));
}

function sourceIdentity(sourceFilename, shopCode) {
  const filename = path.basename(sourceFilename);
  const legacy = /^([a-z0-9]+)\.shopee-shop-stats\.(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})(?: ?\(\d+\))?\.xlsx$/iu.exec(filename);
  if (legacy) {
    if (legacy[1] !== SHOPEE_SHOP_PROFILES[shopCode].statisticsUsername) {
      throw new Error('Statistics filename does not identify the selected shop.');
    }
    return { filename, format: 'shop-stats-confirmed', sheetName: SHEET,
      startDate: `${legacy[2]}-${legacy[3]}-${legacy[4]}`,
      endDate: `${legacy[5]}-${legacy[6]}-${legacy[7]}` };
  }
  const overview = /^sales_overview_(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})(?: ?\(\d+\))?\.xlsx$/iu.exec(filename);
  if (!overview) throw new Error('Statistics filename is not a recognized Shopee Business Insights export.');
  return { filename, format: 'sales-overview', sheetName: OVERVIEW_SHEET,
    startDate: `${overview[1]}-${overview[2]}-${overview[3]}`,
    endDate: `${overview[4]}-${overview[5]}-${overview[6]}` };
}

function exactColumns(headers, expected) {
  return Object.fromEntries(Object.entries(expected).map(([key, header]) => {
    const indices = headers.flatMap((item, index) => item === header ? [index] : []);
    if (indices.length !== 1) throw new Error(`Missing/duplicate confirmed header: ${header}`);
    return [key, indices[0]];
  }));
}

function parseSalesOverviewRows(rows, { shopCode, identity, sourceSha256, observedAt }) {
  const summaryHeaders = (rows[0] || []).map(text);
  const dailyHeaders = (rows[3] || []).map(text);
  const summaryColumns = exactColumns(summaryHeaders, {
    date: OVERVIEW_HEADERS.date,
    salesTotal: OVERVIEW_HEADERS.salesTotal,
  });
  const dailyColumns = exactColumns(dailyHeaders, OVERVIEW_HEADERS);
  if ((rows[2] || []).some(value => text(value))) throw new Error('Unexpected statistics spacer content.');
  const displayDate = value => value.split('-').reverse().join('-');
  const expectedPeriod = `${displayDate(identity.startDate)}-${displayDate(identity.endDate)}`;
  if (text(rows[1]?.[summaryColumns.date]) !== expectedPeriod) {
    throw new Error('Statistics summary period does not match the filename.');
  }

  const controlSales = readMetric(rows[1]?.[summaryColumns.salesTotal], 'salesTotal');
  const expectedDates = datesInRange(identity.startDate, identity.endDate);
  const byDate = new Map();
  const intervals = new Set();
  const hoursByDate = new Map();
  let hourlyRows = 0;
  let dailyRows = 0;
  for (const [index, row] of rows.slice(4).entries()) {
    if (row.every(value => !text(value))) continue;
    const rawDate = text(row[dailyColumns.date]);
    const match = /^(\d{2})-(\d{2})-(\d{4})(?:\s+([01]\d|2[0-3]):(\d{2}))?$/u.exec(rawDate);
    if (!match || (match[4] && match[5] !== '00')) throw new Error('Invalid Sales Overview interval.');
    const date = isoDate(`${match[3]}-${match[2]}-${match[1]}`);
    if (date < identity.startDate || date > identity.endDate) throw new Error('Out-of-period Sales Overview interval.');
    const interval = match[4] ? `${date}T${match[4]}:00` : date;
    if (intervals.has(interval)) throw new Error('Duplicate Sales Overview interval.');
    intervals.add(interval);
    if (match[4]) {
      hourlyRows += 1;
      const hours = hoursByDate.get(date) || new Set();
      hours.add(match[4]);
      hoursByDate.set(date, hours);
    } else {
      dailyRows += 1;
    }
    const salesTotal = readMetric(row[dailyColumns.salesTotal], 'salesTotal');
    const orderCount = readMetric(row[dailyColumns.orderCount], 'orderCount');
    const aggregate = byDate.get(date) || { salesTotal: 0, orderCount: 0, sourceRow: index + 5 };
    aggregate.salesTotal += salesTotal;
    aggregate.orderCount += orderCount;
    if (!Number.isSafeInteger(aggregate.salesTotal) || !Number.isSafeInteger(aggregate.orderCount)) {
      throw new Error('Sales Overview daily total exceeds precision.');
    }
    byDate.set(date, aggregate);
  }
  if (hourlyRows && dailyRows) throw new Error('Mixed Sales Overview interval granularities are not supported.');
  if (hourlyRows && expectedDates.some(date => hoursByDate.get(date)?.size !== 24)) {
    throw new Error('Sales Overview hourly coverage is incomplete.');
  }
  if (expectedDates.some(date => !byDate.has(date))) throw new Error('Statistics daily coverage is incomplete.');
  const totalSales = [...byDate.values()].reduce((sum, value) => sum + value.salesTotal, 0);
  if (!Number.isSafeInteger(totalSales) || totalSales !== controlSales) {
    throw new Error('Confirmed daily/summary mismatch: salesTotal');
  }
  const facts = expectedDates.map(date => ({ shopCode, date, ...amountUnits({
    salesTotal: byDate.get(date).salesTotal,
    orderCount: byDate.get(date).orderCount,
    cancelledOrderCount: null,
    cancelledSales: null,
    returnedOrderCount: null,
    returnedSales: null,
  }), sourceRow: byDate.get(date).sourceRow }));
  const orderCount = [...byDate.values()].reduce((sum, value) => sum + value.orderCount, 0);
  return { shopCode, sourceFilename: identity.filename, sourceSha256,
    observedAt: new Date(observedAt).toISOString(), startDate: identity.startDate,
    endDate: identity.endDate, sheetName: identity.sheetName,
    reportFormat: identity.format,
    control: { salesTotal: controlSales / 100, orderCount,
      cancelledOrderCount: null, cancelledSales: null, returnedOrderCount: null, returnedSales: null },
    facts };
}

function parseConfirmedSalesRows(rows, { shopCode, sourceFilename, sourceSha256, observedAt }) {
  shopCode = requireShopeeShopCode(shopCode);
  const identity = sourceIdentity(sourceFilename, shopCode);
  const { filename, startDate, endDate } = identity;
  const expectedDates = datesInRange(startDate, endDate);
  if (!/^[a-f0-9]{64}$/u.test(sourceSha256 || '')) throw new Error('Source SHA-256 is required.');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(observedAt || '')
    || Number.isNaN(Date.parse(observedAt))) throw new Error('Explicit ISO observation time with timezone is required.');
  parseBangkokDate(observedAt.slice(0, 19).replace('T', ' '));
  // Only complete historical report days are accepted, not an in-progress day.
  if (Date.parse(`${endDate}T23:59:59+07:00`) > Date.parse(observedAt)) throw new Error('Report period has not finished at the observation time.');
  if (identity.format === 'sales-overview') {
    return parseSalesOverviewRows(rows, { shopCode, identity, sourceSha256, observedAt });
  }
  const headers = (rows[0] || []).map(text);
  const summaryColumns = exactColumns(headers, HEADERS);
  const displayDate = value => value.split('-').reverse().join('-');
  if (text(rows[1]?.[summaryColumns.date]) !== `${displayDate(startDate)}-${displayDate(endDate)}`) throw new Error('Statistics summary period does not match the filename.');
  if ((rows[2] || []).some(value => text(value))) throw new Error('Unexpected statistics spacer content.');
  const detailHeaders = (rows[3] || []).map(text);
  const hasDailyHeader = detailHeaders.includes(HEADERS.date);
  const hasHourlyHeader = detailHeaders.includes('เวลา');
  if (hasDailyHeader === hasHourlyHeader) throw new Error('Missing or ambiguous statistics interval header.');
  const hourly = hasHourlyHeader;
  const detailColumns = exactColumns(detailHeaders, {
    ...HEADERS,
    date: hourly ? 'เวลา' : HEADERS.date,
  });
  const control = metricsFrom(rows[1], summaryColumns);
  const totals = Object.fromEntries(METRICS.map(key => [key, 0]));
  const intervals = new Set();
  const hoursByDate = new Map();
  const byDate = new Map();
  for (const [index, row] of rows.slice(4).entries()) {
    if (row.every(value => !text(value))) continue;
    const rawInterval = text(row[detailColumns.date]);
    const match = /^(\d{2})-(\d{2})-(\d{4})(?:\s+([01]\d|2[0-3]):(\d{2}))?$/u.exec(rawInterval);
    if (!match || (hourly ? !match[4] || match[5] !== '00' : Boolean(match[4]))) {
      throw new Error(`Invalid ${hourly ? 'hourly' : 'daily'} statistics interval.`);
    }
    const date = isoDate(`${match[3]}-${match[2]}-${match[1]}`);
    if (date < startDate || date > endDate) throw new Error('Out-of-period statistics interval.');
    const interval = hourly ? `${date}T${match[4]}:00` : date;
    if (intervals.has(interval)) throw new Error('Duplicate statistics interval.');
    intervals.add(interval);
    if (hourly) {
      const hours = hoursByDate.get(date) || new Set();
      hours.add(match[4]);
      hoursByDate.set(date, hours);
    }
    const amounts = metricsFrom(row, detailColumns);
    const aggregate = byDate.get(date) || {
      ...Object.fromEntries(METRICS.map(key => [key, 0])),
      sourceRow: index + 5,
    };
    for (const key of METRICS) {
      totals[key] += amounts[key];
      aggregate[key] += amounts[key];
      if (!Number.isSafeInteger(totals[key]) || !Number.isSafeInteger(aggregate[key])) {
        throw new Error('Confirmed statistics total exceeds precision.');
      }
    }
    byDate.set(date, aggregate);
  }
  if (hourly && expectedDates.some(date => hoursByDate.get(date)?.size !== 24)) {
    throw new Error('Statistics hourly coverage is incomplete.');
  }
  if (expectedDates.some(date => !byDate.has(date))) throw new Error('Statistics daily coverage is incomplete.');
  for (const key of METRICS) {
    if (!Number.isSafeInteger(totals[key]) || totals[key] !== control[key]) throw new Error(`Confirmed daily/summary mismatch: ${key}`);
  }
  const facts = expectedDates.map(date => ({
    shopCode,
    date,
    ...amountUnits(byDate.get(date)),
    sourceRow: byDate.get(date).sourceRow,
  }));
  return { shopCode, sourceFilename: filename, sourceSha256, observedAt: new Date(observedAt).toISOString(),
    startDate, endDate, sheetName: SHEET, reportFormat: identity.format,
    control: amountUnits(control), facts };
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
  const identity = sourceIdentity(sourceFilename, requireShopeeShopCode(options.shopCode));
  const sheet = workbook.getWorksheet(identity.sheetName);
  if (!sheet) throw new Error(`Original ${identity.sheetName} worksheet is required; other tabs are not substitutes.`);
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
    PRIMARY_METRICS.forEach(metric => readMetric(row[metric], metric));
    OPTIONAL_METRICS.forEach(metric => readMetric(row[metric], metric, { nullable: true }));
    keys.add(key);
  }
  const summarizeEvidence = selected => {
    const sources = new Map();
    for (const row of selected) {
      const metricSources = row.metricEvidence
        ? [
          ['confirmedSales', ['salesTotal', 'orderCount']],
          ['cancellations', ['cancelledSales', 'cancelledOrderCount']],
          ['returns', ['returnedSales', 'returnedOrderCount']],
        ].map(([group, metrics]) => ({ ...row.metricEvidence[group], metrics })).filter(source => source.sourceFilename)
        : [{ ...row, metrics: METRICS.filter(metric => row[metric] != null) }];
      for (const source of metricSources) {
        const values = [source.sourceFilename, source.sourceSha256, source.observedAt];
        if (values.every(value => value == null)) continue;
        if (values.some(value => value == null) || !/^[a-f0-9]{64}$/u.test(source.sourceSha256)) {
          throw new Error('Invalid confirmed source evidence.');
        }
        const observedAt = new Date(source.observedAt);
        const importedAt = source.importedAt == null ? null : new Date(source.importedAt);
        if (Number.isNaN(observedAt.getTime()) || (importedAt && Number.isNaN(importedAt.getTime()))) {
          throw new Error('Invalid confirmed source evidence timestamp.');
        }
        const evidenceKey = `${row.shopCode}:${source.sourceSha256}`;
        const evidence = sources.get(evidenceKey) || {
          shopCode: row.shopCode,
          sourceFilename: source.sourceFilename,
          sourceSha256: source.sourceSha256,
          observedAt: observedAt.toISOString(),
          importedAt: importedAt?.toISOString() || null,
          coveredDates: new Set(),
          metrics: new Set(),
        };
        if (evidence.sourceFilename !== source.sourceFilename || evidence.observedAt !== observedAt.toISOString()
          || evidence.importedAt !== (importedAt?.toISOString() || null)) {
          throw new Error('Conflicting confirmed source evidence.');
        }
        evidence.coveredDates.add(row.date);
        source.metrics.forEach(metric => evidence.metrics.add(metric));
        sources.set(evidenceKey, evidence);
      }
    }
    const evidence = [...sources.values()].map(source => {
      const coveredDates = [...source.coveredDates].sort();
      return { shopCode: source.shopCode, sourceFilename: source.sourceFilename,
        sourceSha256: source.sourceSha256, observedAt: source.observedAt, importedAt: source.importedAt,
        metrics: [...source.metrics].sort(), coveredStartDate: coveredDates[0],
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
      const nullable = OPTIONAL_METRICS.includes(key);
      const unavailable = nullable && selected.some(row => readMetric(row[key], key, { nullable: true }) == null);
      const sum = unavailable ? null : selected.reduce((total, row) => total + readMetric(row[key], key, { nullable }), 0);
      if (sum == null) {
        result[key] = null;
        continue;
      }
      if (!Number.isSafeInteger(sum)) throw new Error('Confirmed total exceeds precision.');
      result[key] = missingDays.length ? null : key.endsWith('Count') ? sum : sum / 100;
    }
    result.salesAfterCancellation = missingDays.length || result.cancelledSales == null
      ? null
      : (moneyCents(result.salesTotal) - moneyCents(result.cancelledSales)) / 100;
    return { ...result, ...summarizeEvidence(selected) };
  };
  return { metric: 'shopee_confirmed_gross_sales', currency: 'THB', dateBasis: 'confirmed_report_date',
    sourceSheet: `${SHEET} / ${OVERVIEW_SHEET}`, startDate, endDate, ...summarize(shops),
    shops: shops.map(code => ({ shopCode: code, ...summarize([code]) })),
    daily: [...rows].sort((a, b) => a.shopCode.localeCompare(b.shopCode) || a.date.localeCompare(b.date)) };
}

async function getConfirmedSalesSummary(filters) {
  const { listConfirmedSalesDays } = require('../db/shopeeConfirmedSalesRepository');
  return summarizeConfirmedSales(await listConfirmedSalesDays(filters), filters);
}

module.exports = { HEADERS, OVERVIEW_HEADERS, SHEET, OVERVIEW_SHEET, METRICS, datesInRange, parseConfirmedSalesRows, readConfirmedSalesSource,
  readConfirmedSalesSourceBuffer, summarizeConfirmedSales, getConfirmedSalesSummary };
