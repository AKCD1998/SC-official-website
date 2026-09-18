const { getTables } = require("../tables");

const REPORT_TYPES = Object.freeze([
  "business-insights",
  "orders",
  "return-refund-cancel",
  "financial-statement",
  "seller-balance",
  "income-transferred",
  "income-pending",
  "etax-receipt-invoice",
]);

function mapJob(row) {
  return {
    jobId: row.job_id,
    shopCode: row.shop_code,
    reportType: row.report_type,
    sourceSha256: row.source_sha256,
    sourceFilename: row.source_filename,
    observedAt: new Date(row.observed_at).toISOString(),
    dateFrom: String(row.date_from).slice(0, 10),
    dateTo: String(row.date_to).slice(0, 10),
    resultStatus: row.result_status,
    reconciliationStatus: row.reconciliation_status,
    importedAt: new Date(row.imported_at).toISOString(),
  };
}

async function listSuccessfulIngestJobs({ client, startDate, endDate }) {
  const tables = getTables();
  const result = await client.query(`
    SELECT job_id, shop_code, report_type, source_sha256, source_filename,
           observed_at, date_from::text AS date_from, date_to::text AS date_to,
           result_status, reconciliation_status, imported_at
    FROM ${tables.shopeeSalesIngestJobs}
    WHERE date_from <= $2::date
      AND date_to >= $1::date
      AND report_type = ANY($3::text[])
    ORDER BY shop_code, report_type, observed_at DESC, imported_at DESC, job_id DESC
  `, [startDate, endDate, REPORT_TYPES]);
  const observations = await client.query(`
    SELECT job_id, shop_code, report_type, date_from::text AS date_from, date_to::text AS date_to,
           observed_at, result_status, reason_code, recorded_at, portal_account, source_validation
    FROM ${tables.shopeeDocumentObservations}
    WHERE date_from BETWEEN $1::date AND $2::date
    ORDER BY observed_at DESC, recorded_at DESC, job_id DESC
  `, [startDate, endDate]);
  return [...result.rows.map(mapJob), ...observations.rows.map((row) => ({
    jobId: row.job_id, shopCode: row.shop_code, reportType: row.report_type,
    dateFrom: row.date_from, dateTo: row.date_to,
    observedAt: new Date(row.observed_at).toISOString(),
    importedAt: new Date(row.recorded_at).toISOString(),
    resultStatus: row.result_status, reasonCode: row.reason_code, portalAccount: row.portal_account,
    earliestAvailableDate: row.source_validation?.earliestAvailableDate,
  }))];
}

module.exports = { REPORT_TYPES, listSuccessfulIngestJobs, mapJob };
