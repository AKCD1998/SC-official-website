const { getTables } = require("../tables");

function mapJob(row) {
  if (!row) return null;
  const dateOnly = (value) => value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
  return {
    jobId: row.job_id,
    shopCode: row.shop_code,
    reportType: row.report_type,
    sha256: row.source_sha256,
    sourceFilename: row.source_filename,
    observedAt: new Date(row.observed_at).toISOString(),
    dateFrom: dateOnly(row.date_from),
    dateTo: dateOnly(row.date_to),
    status: row.result_status,
    sourceRowCount: Number(row.source_row_count),
    reconciliationStatus: row.reconciliation_status,
    coverage: row.response_metadata?.coverage || null,
    importedAt: new Date(row.imported_at).toISOString(),
  };
}

async function getIngestJob(client, jobId) {
  const tables = getTables();
  const result = await client.query(
    `SELECT * FROM ${tables.shopeeSalesIngestJobs} WHERE job_id = $1`,
    [jobId],
  );
  return mapJob(result.rows[0]);
}

async function insertIngestJob(client, value) {
  const tables = getTables();
  const result = await client.query(`
    INSERT INTO ${tables.shopeeSalesIngestJobs}
      (job_id, shop_code, report_type, source_sha256, source_filename, observed_at,
       date_from, date_to, result_status, source_row_count, reconciliation_status,
       response_metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
    RETURNING *
  `, [
    value.jobId,
    value.shopCode,
    value.reportType,
    value.sha256,
    value.sourceFilename,
    value.observedAt,
    value.dateFrom,
    value.dateTo,
    value.status,
    value.sourceRowCount,
    value.reconciliationStatus,
    JSON.stringify({ coverage: value.coverage || null }),
  ]);
  return mapJob(result.rows[0]);
}

module.exports = { getIngestJob, insertIngestJob, mapJob };
