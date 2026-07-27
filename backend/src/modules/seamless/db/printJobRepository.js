const pool = require("../../../../db");
const { notFound } = require("../errors");
const { getTables } = require("../tables");
const { normalizeString } = require("../validators");

const ACTIVE_STATUSES = ["queued", "downloading", "sent_to_spooler", "printing"];
const STALE_STATUSES = ["downloading", "sent_to_spooler", "printing"];
const STALE_AFTER_MINUTES = 30;

function executor(client) {
  return client || pool;
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : value || "";
}

function mapPrintJob(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    processingRecordId: row.processing_record_id,
    generatedFileId: row.generated_file_id || "",
    attemptNo: row.attempt_no,
    isReprint: !!row.is_reprint,
    reprintReason: row.reprint_reason || "",
    requestedBy: row.requested_by || "",
    status: row.status,
    agentHost: row.agent_host || "",
    printerName: row.printer_name || "",
    spoolerJobId: row.spooler_job_id === null ? null : row.spooler_job_id,
    errorMessage: row.error_message || "",
    documentUploadedAt: toIso(row.document_uploaded_at),
    queuedAt: toIso(row.queued_at),
    sentToSpoolerAt: toIso(row.sent_to_spooler_at),
    completedAt: toIso(row.completed_at),
    lineNotifiedAt: toIso(row.line_notified_at),
    lineNotifyError: row.line_notify_error || "",
    metadata: row.metadata || {},
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

async function getPrintJobById(id, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(`SELECT * FROM ${tables.printJobs} WHERE id = $1`, [id]);

  if (!result.rows.length) {
    throw notFound(`Print job not found for id: ${id}`);
  }

  return mapPrintJob(result.rows[0]);
}

async function countPrintJobsForRecord(processingRecordId, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `SELECT count(*)::int AS count FROM ${tables.printJobs} WHERE processing_record_id = $1`,
    [processingRecordId],
  );

  return result.rows[0].count;
}

async function hasCompletedPrintJob(processingRecordId, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `SELECT 1 FROM ${tables.printJobs} WHERE processing_record_id = $1 AND status = 'completed' LIMIT 1`,
    [processingRecordId],
  );

  return result.rows.length > 0;
}

async function getAttemptPreview(processingRecordId, client = null) {
  const attemptNo = (await countPrintJobsForRecord(processingRecordId, client)) + 1;
  const isReprint = await hasCompletedPrintJob(processingRecordId, client);

  return { nextAttemptNo: attemptNo, isReprint };
}

async function listPrintQueueCandidates(autoPrintSince = null, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `
      SELECT pr.*
      FROM ${tables.processingRecords} pr
      WHERE (
        ($1::timestamptz IS NOT NULL AND pr.printed = false AND pr.uploaded_at >= $1::timestamptz)
        OR EXISTS (
          SELECT 1 FROM ${tables.printJobs} pj
          WHERE pj.processing_record_id = pr.id AND pj.status = 'queued'
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${tables.printJobs} pj2
        WHERE pj2.processing_record_id = pr.id
          AND pj2.status = ANY($2)
          AND pj2.agent_host IS NOT NULL
      )
      ORDER BY pr.uploaded_at ASC NULLS LAST
    `,
    [autoPrintSince || null, ACTIVE_STATUSES],
  );

  return result.rows;
}

async function listActivePrintJobs(processingRecordId = null, client = null) {
  const db = executor(client);
  const tables = getTables();
  const params = [ACTIVE_STATUSES];
  let where = "status = ANY($1)";

  if (processingRecordId) {
    params.push(processingRecordId);
    where += ` AND processing_record_id = $${params.length}`;
  }

  const result = await db.query(
    `SELECT * FROM ${tables.printJobs} WHERE ${where} ORDER BY queued_at DESC`,
    params,
  );

  return result.rows.map(mapPrintJob);
}

// A record can already have an unclaimed `queued` row (from an admin request-print, or a
// stale job that requeueStaleJobs put back with agent_host cleared) before the agent ever
// polls it. The agent must claim that existing row instead of inserting a new one — otherwise
// the original row is left `queued` forever and the record reappears in the print queue on
// every subsequent poll even after the agent's own (separate) job completes successfully.
async function claimQueuedJob(processingRecordId, claim, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `
      UPDATE ${tables.printJobs}
      SET agent_host = $2, printer_name = COALESCE($3, printer_name)
      WHERE id = (
        SELECT id FROM ${tables.printJobs}
        WHERE processing_record_id = $1
          AND status = 'queued'
          AND agent_host IS NULL
        ORDER BY queued_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `,
    [processingRecordId, normalizeString(claim.agentHost) || null, normalizeString(claim.printerName) || null],
  );

  if (!result.rows.length) {
    return null;
  }

  return mapPrintJob(result.rows[0]);
}

async function createPrintJob(job, client = null) {
  const db = executor(client);
  const tables = getTables();
  const processingRecordId = job.processingRecordId;
  const attemptNo = (await countPrintJobsForRecord(processingRecordId, client)) + 1;
  const isReprint = await hasCompletedPrintJob(processingRecordId, client);

  const result = await db.query(
    `
      INSERT INTO ${tables.printJobs} (
        processing_record_id,
        generated_file_id,
        attempt_no,
        is_reprint,
        reprint_reason,
        requested_by,
        status,
        agent_host,
        printer_name,
        document_uploaded_at,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      RETURNING *
    `,
    [
      processingRecordId,
      job.generatedFileId || null,
      attemptNo,
      isReprint,
      normalizeString(job.reprintReason) || null,
      normalizeString(job.requestedBy) || null,
      normalizeString(job.status) || "queued",
      normalizeString(job.agentHost) || null,
      normalizeString(job.printerName) || null,
      job.documentUploadedAt || null,
      JSON.stringify(job.metadata || {}),
    ],
  );

  return mapPrintJob(result.rows[0]);
}

async function updatePrintJob(id, patch, client = null) {
  const db = executor(client);
  const tables = getTables();
  const existing = await getPrintJobById(id, client);
  const updates = [];
  const values = [];

  function set(column, value) {
    values.push(value);
    updates.push(`${column} = $${values.length}`);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "status")) {
    set("status", normalizeString(patch.status) || existing.status);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "agentHost")) {
    set("agent_host", normalizeString(patch.agentHost) || null);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "spoolerJobId")) {
    set("spooler_job_id", patch.spoolerJobId === null ? null : Number(patch.spoolerJobId));
  }

  if (Object.prototype.hasOwnProperty.call(patch, "errorMessage")) {
    set("error_message", normalizeString(patch.errorMessage) || null);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "sentToSpoolerAt")) {
    set("sent_to_spooler_at", normalizeString(patch.sentToSpoolerAt) || null);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "completedAt")) {
    set("completed_at", normalizeString(patch.completedAt) || null);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "lineNotifiedAt")) {
    set("line_notified_at", normalizeString(patch.lineNotifiedAt) || null);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "lineNotifyError")) {
    set("line_notify_error", normalizeString(patch.lineNotifyError) || null);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "metadata")) {
    set("metadata", JSON.stringify(patch.metadata || {}));
  }

  if (!updates.length) {
    return existing;
  }

  values.push(existing.id);
  const result = await db.query(
    `
      UPDATE ${tables.printJobs}
      SET ${updates.join(", ")}
      WHERE id = $${values.length}
      RETURNING *
    `,
    values,
  );

  return mapPrintJob(result.rows[0]);
}

async function requeueStaleJobs(client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `
      SELECT * FROM ${tables.printJobs}
      WHERE (
        status = ANY($1)
        OR (status = 'queued' AND agent_host IS NOT NULL)
      )
        AND updated_at < now() - ($2 || ' minutes')::interval
    `,
    [STALE_STATUSES, STALE_AFTER_MINUTES],
  );

  const requeued = [];

  for (const row of result.rows) {
    const job = mapPrintJob(row);
    const metadata = { ...job.metadata };
    const staleLog = Array.isArray(metadata.staleRequeueLog) ? metadata.staleRequeueLog : [];

    staleLog.push({
      requeuedAt: new Date().toISOString(),
      previousStatus: job.status,
      previousAgentHost: job.agentHost || "",
    });
    metadata.staleRequeueLog = staleLog;

    requeued.push(
      await updatePrintJob(
        job.id,
        {
          status: "queued",
          agentHost: null,
          metadata,
        },
        client,
      ),
    );
  }

  return requeued;
}

module.exports = {
  claimQueuedJob,
  createPrintJob,
  getAttemptPreview,
  getPrintJobById,
  listActivePrintJobs,
  listPrintQueueCandidates,
  mapPrintJob,
  requeueStaleJobs,
  updatePrintJob,
};
