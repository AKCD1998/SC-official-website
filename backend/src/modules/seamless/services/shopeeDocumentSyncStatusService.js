const pool = require("../../../../db");
const repository = require("../db/shopeeDocumentSyncStatusRepository");
const { SHOPEE_SHOP_PROFILES } = require("./shopeeShops");

const DAY_MS = 86_400_000;

const REPORTS = Object.freeze([
  Object.freeze({ key: "business-insights", label: "Business Insights — ภาพรวมยอดขาย", cadence: "daily" }),
  Object.freeze({ key: "orders", label: "คำสั่งซื้อทั้งหมด (Order All)", cadence: "rolling" }),
  Object.freeze({
    key: "return-refund-cancel",
    label: "คำสั่งซื้อที่ยกเลิก / คืนเงินหรือคืนสินค้า / จัดส่งไม่สำเร็จ",
    cadence: "rolling",
  }),
  Object.freeze({ key: "financial-statement", label: "รายงานการเงิน", cadence: "weekly" }),
  Object.freeze({ key: "seller-balance", label: "Seller Balance", cadence: "weekly" }),
  Object.freeze({
    key: "income-transferred",
    label: "รายละเอียดรายรับของฉัน — โอนเงินแล้ว",
    cadence: "weekly",
  }),
  Object.freeze({
    key: "income-pending",
    label: "รายละเอียดรายรับของฉัน — รอดำเนินการ",
    cadence: "weekly",
    unavailableUntilExported: true,
  }),
]);

function offsetDate(value, days) {
  return new Date(Date.parse(`${value}T00:00:00.000Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function bangkokDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Bangkok",
    year: "numeric",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function enumerateDatesDescending(startDate, endDate) {
  const values = [];
  for (let cursor = endDate; cursor >= startDate; cursor = offsetDate(cursor, -1)) {
    values.push(cursor);
  }
  return values;
}

function mondayOfWeek(date) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  const daysSinceMonday = (parsed.getUTCDay() + 6) % 7;
  return offsetDate(date, -daysSinceMonday);
}

function latestJobForDate(jobs, date) {
  return jobs.find((job) => job.dateFrom <= date && job.dateTo >= date) || null;
}

function cellStatus(report, date, currentMonday, evidence) {
  if (evidence) return "ingested";
  if (report.unavailableUntilExported) return "unavailable";
  if (report.cadence === "weekly" && date >= currentMonday) return "not_due";
  return "missing";
}

function summarizeRow({ currentMonday, dates, jobs, report }) {
  const cells = dates.map((date) => {
    const evidence = latestJobForDate(jobs, date);
    const status = cellStatus(report, date, currentMonday, evidence);
    return {
      date,
      status,
      ...(evidence ? {
        evidence: {
          dateFrom: evidence.dateFrom,
          dateTo: evidence.dateTo,
          importedAt: evidence.importedAt,
          jobId: evidence.jobId,
          observedAt: evidence.observedAt,
          reconciliationStatus: evidence.reconciliationStatus,
          resultStatus: evidence.resultStatus,
          sourceFilename: evidence.sourceFilename,
          sourceSha256: evidence.sourceSha256,
        },
      } : {}),
    };
  });
  const expectedCells = cells.filter((cell) => !["not_due", "unavailable"].includes(cell.status));
  const ingestedCount = expectedCells.filter((cell) => cell.status === "ingested").length;
  const missingCount = expectedCells.filter((cell) => cell.status === "missing").length;
  const ingestedJobs = jobs.filter((job) => job.dateFrom <= dates[0] && job.dateTo >= dates.at(-1));
  const latestCoveredDate = jobs.length
    ? jobs.map((job) => job.dateTo).sort().at(-1)
    : null;
  const latestImportedAt = jobs.length
    ? jobs.map((job) => job.importedAt).sort().at(-1)
    : null;
  let status = missingCount ? "incomplete" : "complete";
  if (!expectedCells.length) status = report.unavailableUntilExported ? "unavailable" : "not_due";
  return {
    cadence: report.cadence,
    expectedCount: expectedCells.length,
    ingestedCount,
    label: report.label,
    latestCoveredDate,
    latestImportedAt,
    missingCount,
    reportType: report.key,
    status,
    cells,
    sourceCount: new Set(ingestedJobs.map((job) => job.sourceSha256)).size,
  };
}

function buildDocumentSyncStatus({ days, jobs, now = new Date() }) {
  const today = bangkokDate(now);
  const endDate = offsetDate(today, -1);
  const startDate = offsetDate(endDate, -(days - 1));
  const dates = enumerateDatesDescending(startDate, endDate);
  const currentMonday = mondayOfWeek(today);
  const shops = Object.values(SHOPEE_SHOP_PROFILES).map((profile) => {
    const shopJobs = jobs.filter((job) => job.shopCode === profile.code);
    const rows = REPORTS.map((report) => summarizeRow({
      currentMonday,
      dates,
      jobs: shopJobs.filter((job) => job.reportType === report.key),
      report,
    }));
    const requiredRows = rows.filter((row) => row.status !== "unavailable");
    return {
      shopCode: profile.code,
      shopName: profile.displayName,
      completeRowCount: requiredRows.filter((row) => row.status === "complete").length,
      incompleteRowCount: requiredRows.filter((row) => row.status === "incomplete").length,
      latestImportedAt: shopJobs.length
        ? shopJobs.map((job) => job.importedAt).sort().at(-1)
        : null,
      rows,
    };
  });
  return {
    asOfDate: endDate,
    days,
    dates,
    generatedAt: now.toISOString(),
    startDate,
    endDate,
    timezone: "Asia/Bangkok",
    shops,
  };
}

async function getShopeeDocumentSyncStatus({ days, now = new Date() }) {
  const today = bangkokDate(now);
  const endDate = offsetDate(today, -1);
  const startDate = offsetDate(endDate, -(days - 1));
  const client = await pool.connect();
  try {
    const jobs = await repository.listSuccessfulIngestJobs({ client, startDate, endDate });
    return buildDocumentSyncStatus({ days, jobs, now });
  } finally {
    client.release();
  }
}

module.exports = {
  REPORTS,
  bangkokDate,
  buildDocumentSyncStatus,
  getShopeeDocumentSyncStatus,
  mondayOfWeek,
  offsetDate,
};
