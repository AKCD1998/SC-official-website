const crypto = require("node:crypto");
const pool = require("../../../../db");
const { badRequest, conflict } = require("../errors");
const { getTables } = require("../tables");
const { SHOPEE_SHOP_PROFILES } = require("./shopeeShops");

const FIELDS = ["shopCode", "reportType", "dateFrom", "dateTo", "portalAccount", "jobId", "observedAt", "resultStatus", "reasonCode", "sourceValidation"];
const PROOF_FIELDS = ["portalAccount", "selectedDate", "exactDailyRangeVerified", "resultRowCount", "searchResponseVerified", "searchEndpoint"];
function exactFields(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every((key) => Object.hasOwn(value, key));
}
function validateObservation(body, now = new Date()) {
  if (!exactFields(body, FIELDS) || !exactFields(body.sourceValidation, PROOF_FIELDS)) {
    throw badRequest("Document observation contains missing or unsupported fields.");
  }
  const profile = SHOPEE_SHOP_PROFILES[body.shopCode];
  const proof = body.sourceValidation;
  const date = /^\d{4}-\d{2}-\d{2}$/u.test(body.dateFrom) ? new Date(`${body.dateFrom}T00:00:00Z`) : null;
  const observed = typeof body.observedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(body.observedAt)
    ? new Date(body.observedAt) : null;
  if (!profile || body.portalAccount !== profile.statisticsUsername
    || body.reportType !== "etax-receipt-invoice" || body.resultStatus !== "no_file"
    || body.reasonCode !== "SHOPEE_ETAX_NO_DOCUMENT_FOR_DATE"
    || !date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== body.dateFrom
    || body.dateTo !== body.dateFrom || proof.selectedDate !== body.dateFrom
    || !observed || !Number.isFinite(observed.getTime()) || observed.getTime() > now.getTime() + 300000
    || date.getTime() > observed.getTime() + 7 * 3600000
    || typeof body.jobId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(body.jobId)
    || proof.portalAccount !== body.portalAccount || proof.exactDailyRangeVerified !== true
    || proof.resultRowCount !== 0 || proof.searchResponseVerified !== true
    || proof.searchEndpoint !== "/api/v1/seller/tax-documents/list") {
    throw badRequest("Document observation does not prove an exact daily empty e-Tax search for this shop.");
  }
  return {
    shopCode: body.shopCode, reportType: body.reportType, dateFrom: body.dateFrom, dateTo: body.dateTo,
    portalAccount: body.portalAccount, jobId: body.jobId, observedAt: observed.toISOString(),
    resultStatus: body.resultStatus, reasonCode: body.reasonCode,
    sourceValidation: Object.fromEntries(PROOF_FIELDS.map((key) => [key, proof[key]])),
  };
}

async function recordDocumentObservation({ body, dbPool = pool, now = new Date() }) {
  const observation = validateObservation(body, now);
  const hash = crypto.createHash("sha256").update(JSON.stringify(observation)).digest("hex");
  const table = getTables().shopeeDocumentObservations;
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`shopee-document-observation:${observation.jobId}`]);
    const prior = await client.query(`SELECT payload_sha256, recorded_at FROM ${table} WHERE job_id = $1`, [observation.jobId]);
    if (prior.rows.length) {
      if (prior.rows[0].payload_sha256 !== hash) throw conflict("Document observation jobId was already recorded with different evidence.");
      await client.query("COMMIT");
      return { status: "already_recorded", jobId: observation.jobId, resultStatus: "no_file", recordedAt: new Date(prior.rows[0].recorded_at).toISOString() };
    }
    const inserted = await client.query(`INSERT INTO ${table}
      (job_id, shop_code, report_type, date_from, date_to, portal_account, observed_at, result_status, reason_code, source_validation, payload_sha256)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING recorded_at`,
    [observation.jobId, observation.shopCode, observation.reportType, observation.dateFrom, observation.dateTo,
      observation.portalAccount, observation.observedAt, observation.resultStatus, observation.reasonCode,
      JSON.stringify(observation.sourceValidation), hash]);
    await client.query("COMMIT");
    return { status: "recorded", jobId: observation.jobId, resultStatus: "no_file", recordedAt: new Date(inserted.rows[0].recorded_at).toISOString() };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
module.exports = { validateObservation, recordDocumentObservation };
