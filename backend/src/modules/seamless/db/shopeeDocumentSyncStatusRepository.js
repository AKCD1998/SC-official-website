const { getTables } = require("../tables");

const REPORT_TYPES = Object.freeze([
  "business-insights",
  "orders",
  "return-refund-cancel",
  "financial-statement",
  "seller-balance",
  "income-transferred",
  "income-pending",
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
  return result.rows.map(mapJob);
}

module.exports = { REPORT_TYPES, listSuccessfulIngestJobs, mapJob };
