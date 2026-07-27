const pool = require("../../../db");
const { readInternalApiToken, readSchemaName } = require("./config");
const { ApiError, notFound } = require("./errors");
const {
  coerceReportDateKey,
  isUuid,
  normalizeBoolean,
  normalizeBranchCodes,
  normalizeLimit,
  normalizeReportDateKey,
  normalizeString,
  parseFormatterMode,
  reportDateKeyToDate,
  requireString,
} = require("./validators");

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdentifier(identifier, label) {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    const error = new Error(`Invalid PostgreSQL ${label}: ${identifier}`);
    error.statusCode = 500;
    throw error;
  }

  return `"${identifier}"`;
}

function getTables() {
  const schemaName = readSchemaName();
  const schemaSql = quoteIdentifier(schemaName, "schema");
  const qualifyTable = (tableName) =>
    `${schemaSql}.${quoteIdentifier(tableName, "table")}`;

  return {
    processingRecordBranchCodes: qualifyTable("processing_record_branch_codes"),
    processingRecords: qualifyTable("processing_records"),
  };
}

function executor(client) {
  return client || pool;
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : value || "";
}

function mapRecord(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    legacyRegistryId: row.legacy_registry_id || "",
    reportDate: row.report_date_key || "",
    reportType: row.report_type || "",
    filename: row.filename || "",
    driveFileId: row.legacy_drive_file_id || "",
    driveFileUrl: row.legacy_drive_file_url || "",
    uploadedAt: toIso(row.uploaded_at),
    uploadedBy: row.uploaded_by || "",
    printed: !!row.printed,
    printedAt: toIso(row.printed_at),
    printedBy: row.printed_by || "",
    sourceUploadName: row.source_upload_name || "",
    notes: row.notes || "",
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    lastAction: row.last_action || "",
    branchCodes: row.legacy_branch_codes || "",
    metadata: row.metadata || {},
  };
}

async function syncBranchCodes(recordId, branchCodes, client = null) {
  const db = executor(client);
  const tables = getTables();
  const normalized = normalizeBranchCodes(branchCodes);

  await db.query(
    `DELETE FROM ${tables.processingRecordBranchCodes} WHERE processing_record_id = $1`,
    [recordId],
  );

  if (!normalized) {
    return;
  }

  for (const branchCode of normalized.split(/,\s*/)) {
    // eslint-disable-next-line no-await-in-loop
    await db.query(
      `
        INSERT INTO ${tables.processingRecordBranchCodes} (processing_record_id, branch_code)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `,
      [recordId, branchCode],
    );
  }
}

async function listProcessingRecords(filters = {}, client = null) {
  const db = executor(client);
  const tables = getTables();
  const where = [];
  const params = [];

  if (normalizeString(filters.id)) {
    if (isUuid(filters.id)) {
      params.push(filters.id);
      where.push(`id = $${params.length}`);
    } else {
      params.push(filters.id);
      where.push(`legacy_registry_id = $${params.length}`);
    }
  }

  if (normalizeString(filters.filename)) {
    params.push(normalizeString(filters.filename));
    where.push(`filename = $${params.length}`);
  }

  if (normalizeString(filters.reportType)) {
    params.push(parseFormatterMode(filters.reportType, { allowEmpty: false }));
    where.push(`report_type = $${params.length}`);
  }

  const reportDateKey = normalizeReportDateKey(filters.reportDate);
  if (reportDateKey) {
    params.push(reportDateKey);
    where.push(`report_date_key = $${params.length}`);
  }

  if (normalizeString(filters.driveFileId)) {
    params.push(normalizeString(filters.driveFileId));
    where.push(`legacy_drive_file_id = $${params.length}`);
  }

  const printed = normalizeBoolean(filters.printed);
  if (printed !== null) {
    params.push(printed);
    where.push(`printed = $${params.length}`);
  }

  params.push(normalizeLimit(filters.limit, 250));
  const limitPlaceholder = `$${params.length}`;

  const result = await db.query(
    `
      SELECT *
      FROM ${tables.processingRecords}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY COALESCE(uploaded_at, updated_at, created_at) DESC
      LIMIT ${limitPlaceholder}
    `,
    params,
  );

  return result.rows.map(mapRecord);
}

async function getProcessingRecordById(id, client = null) {
  const records = await listProcessingRecords({ id, limit: 1 }, client);

  if (!records.length) {
    throw notFound(`Processing record not found for id: ${id}`);
  }

  return records[0];
}

async function findProcessingRecordByFilename(filename, client = null) {
  const records = await listProcessingRecords({ filename, limit: 1 }, client);
  return records.length ? records[0] : null;
}

function buildRecordInput(record = {}, defaultAction = "created") {
  const filename = requireString(record.filename, "Processing record filename is required.");
  const reportType = parseFormatterMode(record.reportType, { allowEmpty: false });
  const reportDateKey = coerceReportDateKey(record.reportDate, filename, record.sourceUploadName);
  const branchCodes = normalizeBranchCodes(record.branchCodes || record.branchCode);

  return {
    legacyRegistryId: normalizeString(record.legacyRegistryId || record.id),
    reportDateKey,
    reportDate: reportDateKeyToDate(reportDateKey),
    reportType,
    filename,
    legacyDriveFileId: normalizeString(record.driveFileId || record.legacyDriveFileId),
    legacyDriveFileUrl: normalizeString(record.driveFileUrl || record.legacyDriveFileUrl),
    uploadedAt: normalizeString(record.uploadedAt) || new Date().toISOString(),
    uploadedBy: normalizeString(record.uploadedBy),
    printed: normalizeBoolean(record.printed) === true,
    printedAt: normalizeString(record.printedAt) || null,
    printedBy: normalizeString(record.printedBy),
    sourceUploadName: normalizeString(record.sourceUploadName),
    notes: normalizeString(record.notes),
    lastAction: normalizeString(record.lastAction) || defaultAction,
    branchCodes,
    metadata: record.metadata || {},
  };
}

async function createProcessingRecord(record, client = null) {
  const db = executor(client);
  const tables = getTables();
  const input = buildRecordInput(record, record.lastAction || "created");
  const id = isUuid(record.id) ? record.id : null;
  const columns = [
    "legacy_registry_id",
    "report_date_key",
    "report_date",
    "report_type",
    "filename",
    "legacy_drive_file_id",
    "legacy_drive_file_url",
    "uploaded_at",
    "uploaded_by",
    "printed",
    "printed_at",
    "printed_by",
    "source_upload_name",
    "notes",
    "last_action",
    "legacy_branch_codes",
    "metadata",
  ];
  const values = [
    input.legacyRegistryId || null,
    input.reportDateKey,
    input.reportDate,
    input.reportType,
    input.filename,
    input.legacyDriveFileId || null,
    input.legacyDriveFileUrl || null,
    input.uploadedAt,
    input.uploadedBy || null,
    input.printed,
    input.printedAt,
    input.printedBy || null,
    input.sourceUploadName || null,
    input.notes || null,
    input.lastAction,
    input.branchCodes || null,
    JSON.stringify(input.metadata),
  ];

  if (id) {
    columns.unshift("id");
    values.unshift(id);
  }

  const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
  const result = await db.query(
    `
      INSERT INTO ${tables.processingRecords} (${columns.join(", ")})
      VALUES (${placeholders})
      RETURNING *
    `,
    values,
  );
  const created = mapRecord(result.rows[0]);

  await syncBranchCodes(created.id, input.branchCodes, client);

  return created;
}

async function updateProcessingRecord(id, patch, client = null) {
  const db = executor(client);
  const tables = getTables();
  const existing = await getProcessingRecordById(id, client);
  const updates = [];
  const values = [];

  function set(column, value) {
    values.push(value);
    updates.push(`${column} = $${values.length}`);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "reportType")) {
    set("report_type", parseFormatterMode(patch.reportType, { allowEmpty: false }));
  }

  if (Object.prototype.hasOwnProperty.call(patch, "filename")) {
    set("filename", requireString(patch.filename, "Processing record filename is required."));
  }

  if (Object.prototype.hasOwnProperty.call(patch, "driveFileId")) {
    set("legacy_drive_file_id", normalizeString(patch.driveFileId) || null);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "driveFileUrl")) {
    set("legacy_drive_file_url", normalizeString(patch.driveFileUrl) || null);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "uploadedAt")) {
    set("uploaded_at", normalizeString(patch.uploadedAt) || null);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "uploadedBy")) {
    set("uploaded_by", normalizeString(patch.uploadedBy) || null);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "printed")) {
    set("printed", normalizeBoolean(patch.printed) === true);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "printedAt")) {
    set("printed_at", normalizeString(patch.printedAt) || null);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "printedBy")) {
    set("printed_by", normalizeString(patch.printedBy) || null);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "sourceUploadName")) {
    set("source_upload_name", normalizeString(patch.sourceUploadName) || null);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "reportDate")) {
    const reportDateKey = coerceReportDateKey(
      patch.reportDate,
      existing.filename,
      existing.sourceUploadName,
    );
    set("report_date_key", reportDateKey);
    set("report_date", reportDateKeyToDate(reportDateKey));
  }

  if (Object.prototype.hasOwnProperty.call(patch, "notes")) {
    set("notes", normalizeString(patch.notes) || null);
  }

  let nextBranchCodes = null;
  if (Object.prototype.hasOwnProperty.call(patch, "branchCodes")) {
    nextBranchCodes = normalizeBranchCodes(patch.branchCodes);
    set("legacy_branch_codes", nextBranchCodes || null);
  } else if (Object.prototype.hasOwnProperty.call(patch, "branchCode")) {
    nextBranchCodes = normalizeBranchCodes(patch.branchCode);
    set("legacy_branch_codes", nextBranchCodes || null);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "lastAction")) {
    set("last_action", normalizeString(patch.lastAction) || existing.lastAction || "updated");
  } else {
    set("last_action", existing.lastAction || "updated");
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
      UPDATE ${tables.processingRecords}
      SET ${updates.join(", ")}
      WHERE id = $${values.length}
      RETURNING *
    `,
    values,
  );
  const updated = mapRecord(result.rows[0]);

  if (nextBranchCodes !== null) {
    await syncBranchCodes(updated.id, nextBranchCodes, client);
  }

  return updated;
}

async function upsertProcessingRecordFromPreview(options, client = null) {
  const filename = requireString(options && options.filename, "Preview filename is required.");
  const existing = await findProcessingRecordByFilename(filename, client);
  const reportType = parseFormatterMode(options.reportType, { allowEmpty: false });
  const reportDate = coerceReportDateKey(options.reportDate, filename, options.sourceUploadName);
  const nowIso = new Date().toISOString();

  if (existing) {
    const record = await updateProcessingRecord(
      existing.id,
      {
        reportDate,
        reportType,
        filename,
        driveFileId: options.driveFileId,
        driveFileUrl: options.driveFileUrl,
        uploadedAt: nowIso,
        uploadedBy: options.uploadedBy,
        sourceUploadName: options.sourceUploadName,
        notes: options.notes,
        branchCodes: options.branchCodes,
        lastAction: "uploaded_updated",
        metadata: options.metadata,
      },
      client,
    );

    return {
      ok: true,
      action: "updated",
      reason: "",
      filename,
      record,
    };
  }

  const record = await createProcessingRecord(
    {
      reportDate,
      reportType,
      filename,
      driveFileId: options.driveFileId,
      driveFileUrl: options.driveFileUrl,
      uploadedAt: nowIso,
      uploadedBy: options.uploadedBy,
      printed: false,
      sourceUploadName: options.sourceUploadName,
      notes: options.notes,
      branchCodes: options.branchCodes,
      lastAction: "uploaded_created",
      metadata: options.metadata,
    },
    client,
  );

  return {
    ok: true,
    action: "created",
    reason: "",
    filename,
    record,
  };
}

async function markPrinted(id, printedBy, client = null) {
  const record = await updateProcessingRecord(
    id,
    {
      printed: true,
      printedAt: new Date().toISOString(),
      printedBy: normalizeString(printedBy),
      lastAction: "marked_printed",
    },
    client,
  );

  return {
    ok: true,
    message: "Marked as printed.",
    record,
  };
}

async function markUnprinted(id, client = null) {
  const record = await updateProcessingRecord(
    id,
    {
      printed: false,
      printedAt: "",
      printedBy: "",
      lastAction: "marked_unprinted",
    },
    client,
  );

  return {
    ok: true,
    message: "Marked as unprinted.",
    record,
  };
}

async function inspectDatabaseContext(client = null) {
  const db = executor(client);
  const schemaName = readSchemaName();
  const relationName = `${schemaName}.processing_records`;

  const currentResult = await db.query(
    `
      SELECT
        current_database() AS current_database,
        current_schema() AS current_schema
    `,
  );
  const searchPathResult = await db.query("SHOW search_path");
  const relationResult = await db.query("SELECT to_regclass($1) AS relation_name", [relationName]);

  return {
    currentDatabase: currentResult.rows[0]?.current_database || null,
    currentSchema: currentResult.rows[0]?.current_schema || null,
    searchPath: searchPathResult.rows[0]?.search_path || null,
    targetRelation: relationName,
    relationExistsAs: relationResult.rows[0]?.relation_name || null,
  };
}

function parseBearerToken(headerValue) {
  const text = String(headerValue || "").trim();
  const match = text.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function requireInternalApiToken(req, res, next) {
  try {
    const expectedToken = readInternalApiToken();
    if (!expectedToken) {
      next();
      return;
    }

    const token = parseBearerToken(req.headers.authorization);
    if (token !== expectedToken) {
      res.status(401).json({ error: "Missing or invalid internal API token." });
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
}

function respondWithError(res, error) {
  if (error instanceof ApiError || error.statusCode) {
    res.status(error.statusCode || 500).json({
      error: error.message,
      details: error.details || null,
    });
    return;
  }

  res.status(500).json({ error: error.message || "Unexpected server error." });
}

function createRouteHandler(handler) {
  return async function seamlessRouteHandler(req, res) {
    try {
      await handler(req, res);
    } catch (error) {
      respondWithError(res, error);
    }
  };
}

module.exports = {
  createProcessingRecord,
  createRouteHandler,
  findProcessingRecordByFilename,
  getProcessingRecordById,
  inspectDatabaseContext,
  listProcessingRecords,
  mapRecord,
  markPrinted,
  markUnprinted,
  requireInternalApiToken,
  updateProcessingRecord,
  upsertProcessingRecordFromPreview,
};
