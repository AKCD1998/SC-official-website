import { query, withTransaction } from "../db/pool.js";
import { httpError } from "../utils/httpError.js";
import { parseDateOnlyInput } from "../utils/dateOnly.js";
import {
  applyStockDelta,
  resolveBranchByCode,
  resolveBranchById,
  resolveProductBaseUnitLevel,
  toIsoTimestamp,
  toPositiveNumeric,
} from "./helpers.js";
import {
  applyIncidentResolutionActions,
  normalizeIncidentResolutionActionInput,
  normalizeIncidentResolutionPatientInput,
} from "./incidentResolutionHelpers.js";

const INCIDENT_STATUSES = new Set(["OPEN", "ACKNOWLEDGED", "CLOSED"]);
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const INCIDENT_SOURCE_REF_TYPE = "INCIDENT_REPORT";
let hasIncidentResolutionActionsTableCache = null;
let hasIncidentAdminAuditsTableCache = null;

function toCleanText(value) {
  return String(value ?? "").trim();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    toCleanText(value)
  );
}

function normalizeIncidentStatus(value, { allowEmpty = false, defaultValue = "ACKNOWLEDGED" } = {}) {
  const status = toCleanText(value).toUpperCase();
  if (!status) {
    if (allowEmpty) return "";
    return defaultValue;
  }
  if (!INCIDENT_STATUSES.has(status)) {
    throw httpError(400, `Unsupported incident status: ${status}`);
  }
  return status;
}

function normalizeOptionalText(value, maxLength, fieldName) {
  const text = toCleanText(value);
  if (!text) return null;
  if (maxLength && text.length > maxLength) {
    throw httpError(400, `${fieldName} must be at most ${maxLength} characters`);
  }
  return text;
}

function normalizeRequiredText(value, maxLength, fieldName) {
  const text = normalizeOptionalText(value, maxLength, fieldName);
  if (!text) {
    throw httpError(400, `${fieldName} is required`);
  }
  return text;
}

function normalizeListLimit(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_LIST_LIMIT;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw httpError(400, "limit must be a positive integer");
  }
  return Math.min(Math.floor(numeric), MAX_LIST_LIMIT);
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return fallback;
}

function normalizeIncidentDateFilterStart(value) {
  const normalized = parseDateOnlyInput(value, "fromDate", { allowEmpty: true });
  if (!normalized) return "";
  return toIsoTimestamp(`${normalized}T00:00:00`);
}

function normalizeIncidentDateFilterEndExclusive(value) {
  const normalized = parseDateOnlyInput(value, "toDate", { allowEmpty: true });
  if (!normalized) return "";
  const bangkokStart = new Date(`${normalized}T00:00:00+07:00`);
  bangkokStart.setUTCDate(bangkokStart.getUTCDate() + 1);
  return bangkokStart.toISOString();
}

async function hasIncidentResolutionActionsTable(client) {
  if (hasIncidentResolutionActionsTableCache === true) {
    return true;
  }

  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'incident_report_resolution_actions'
      LIMIT 1
    `
  );

  if (result.rows[0]) {
    hasIncidentResolutionActionsTableCache = true;
    return true;
  }

  return false;
}

async function hasIncidentAdminAuditsTable(client) {
  if (hasIncidentAdminAuditsTableCache === true) {
    return true;
  }

  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'incident_report_admin_audits'
      LIMIT 1
    `
  );

  if (result.rows[0]) {
    hasIncidentAdminAuditsTableCache = true;
    return true;
  }

  return false;
}

function requireIncidentAdminAuditSchemaAvailable(isAvailable) {
  if (!isAvailable) {
    throw httpError(503, "incident report admin audit schema is not deployed yet; run migration 0024 first");
  }
}

function normalizeIncidentItemInput(item, index) {
  const rowLabel = `items[${index}]`;
  const productId = toCleanText(item?.productId ?? item?.product_id);
  const lotId = toCleanText(item?.lotId ?? item?.lot_id);
  const unitLevelId = toCleanText(item?.unitLevelId ?? item?.unit_level_id);
  const qty = toPositiveNumeric(item?.qty, `${rowLabel}.qty`);
  const unitLabel = normalizeOptionalText(
    item?.unitLabel ?? item?.unit_label ?? item?.unitLabelSnapshot ?? item?.unit_label_snapshot,
    160,
    `${rowLabel}.unitLabel`
  );
  const lotNoSnapshot = normalizeOptionalText(
    item?.lotNoSnapshot ?? item?.lot_no_snapshot ?? item?.lotNo ?? item?.lot_no,
    120,
    `${rowLabel}.lotNoSnapshot`
  );
  const expDateSnapshot =
    parseDateOnlyInput(item?.expDateSnapshot ?? item?.exp_date_snapshot, `${rowLabel}.expDateSnapshot`, {
      allowEmpty: true,
    }) || null;
  const note = normalizeOptionalText(item?.note ?? item?.noteText ?? item?.note_text, 2000, `${rowLabel}.note`);

  if (!productId || !isUuid(productId)) {
    throw httpError(400, `${rowLabel}.productId must be a valid UUID`);
  }
  if (lotId && !isUuid(lotId)) {
    throw httpError(400, `${rowLabel}.lotId must be a valid UUID`);
  }
  if (unitLevelId && !isUuid(unitLevelId)) {
    throw httpError(400, `${rowLabel}.unitLevelId must be a valid UUID`);
  }

  return {
    productId,
    lotId: lotId || null,
    unitLevelId: unitLevelId || null,
    qty,
    unitLabel,
    lotNoSnapshot,
    expDateSnapshot,
    note,
  };
}

function normalizeIncidentResolutionPayload(body = {}) {
  const rawActions = Array.isArray(body?.resolutionActions ?? body?.resolution_actions)
    ? body.resolutionActions ?? body.resolution_actions
    : [];

  return {
    resolutionActions: rawActions.map((action, index) =>
      normalizeIncidentResolutionActionInput(action, index)
    ),
    resolutionPatient: normalizeIncidentResolutionPatientInput(
      body?.resolutionPatient ?? body?.resolution_patient,
      { allowEmpty: true }
    ),
  };
}

function buildIncidentCode(runningNo) {
  return `INC-${String(runningNo).padStart(6, "0")}`;
}

function deriveStatusStateForCreate(status, adminUserId, timestamp) {
  if (status === "OPEN") {
    return {
      acknowledgedByAdminUserId: null,
      acknowledgedAt: null,
      closedAt: null,
    };
  }

  if (status === "CLOSED") {
    return {
      acknowledgedByAdminUserId: adminUserId,
      acknowledgedAt: timestamp,
      closedAt: timestamp,
    };
  }

  return {
    acknowledgedByAdminUserId: adminUserId,
    acknowledgedAt: timestamp,
    closedAt: null,
  };
}

function deriveStatusStateForUpdate(currentIncident, nextStatus, adminUserId, timestamp) {
  if (nextStatus === "OPEN") {
    return {
      acknowledgedByAdminUserId: null,
      acknowledgedAt: null,
      closedAt: null,
    };
  }

  if (nextStatus === "ACKNOWLEDGED") {
    return {
      acknowledgedByAdminUserId: adminUserId,
      acknowledgedAt: currentIncident.acknowledgedAt || timestamp,
      closedAt: null,
    };
  }

  return {
    acknowledgedByAdminUserId:
      currentIncident.acknowledgedByAdminUserId || adminUserId,
    acknowledgedAt: currentIncident.acknowledgedAt || timestamp,
    closedAt: timestamp,
  };
}

async function resolveIncidentBranch(client, payload) {
  const branchId = toCleanText(payload?.branchId ?? payload?.branch_id);
  const branchCode = toCleanText(payload?.branchCode ?? payload?.branch_code);

  if (branchId) {
    return resolveBranchById(client, branchId);
  }
  if (branchCode) {
    return resolveBranchByCode(client, branchCode);
  }
  throw httpError(400, "branchId or branchCode is required");
}

async function resolveIncidentProductSnapshot(client, productId) {
  const result = await client.query(
    `
      SELECT
        id,
        product_code AS "productCode",
        trade_name AS "tradeName"
      FROM products
      WHERE id = $1::uuid
      LIMIT 1
    `,
    [productId]
  );

  const product = result.rows[0];
  if (!product) {
    throw httpError(404, `Product not found: ${productId}`);
  }

  return product;
}

async function resolveIncidentLotSnapshot(client, productId, lotId) {
  if (!lotId) return null;

  const result = await client.query(
    `
      SELECT
        id,
        product_id AS "productId",
        lot_no AS "lotNo",
        exp_date::text AS "expDate"
      FROM product_lots
      WHERE id = $1::uuid
        AND product_id = $2::uuid
      LIMIT 1
    `,
    [lotId, productId]
  );

  const lot = result.rows[0];
  if (!lot) {
    throw httpError(404, `Product lot not found: ${lotId}`);
  }

  return lot;
}

async function resolveIncidentUnitSnapshot(client, productId, unitLevelId) {
  if (!unitLevelId) return null;

  const result = await client.query(
    `
      SELECT
        pul.id,
        pul.product_id AS "productId",
        COALESCE(
          NULLIF(TRIM(pul.display_name), ''),
          NULLIF(ut.symbol, ''),
          ut.code,
          pul.code,
          'base'
        ) AS "unitLabel"
      FROM product_unit_levels pul
      LEFT JOIN unit_types ut ON ut.id = pul.unit_type_id
      WHERE pul.id = $1::uuid
        AND pul.product_id = $2::uuid
      LIMIT 1
    `,
    [unitLevelId, productId]
  );

  const unitLevel = result.rows[0];
  if (!unitLevel) {
    throw httpError(404, `Product unit level not found: ${unitLevelId}`);
  }

  return unitLevel;
}

async function getIncidentDetailById(db, incidentId) {
  const headerResult = await db.query(
    `
      SELECT
        ir.id,
        ir.running_no AS "runningNo",
        ir.incident_code AS "incidentCode",
        ir.incident_type AS "incidentType",
        ir.incident_reason AS "incidentReason",
        ir.incident_description AS "incidentDescription",
        ir.branch_id AS "branchId",
        ir.branch_code_snapshot AS "branchCode",
        ir.branch_name_snapshot AS "branchName",
        ir.reporter_user_id AS "reporterUserId",
        COALESCE(NULLIF(TRIM(reporter.full_name), ''), reporter.username, 'unknown') AS "reporterName",
        reporter.username AS "reporterUsername",
        ir.acknowledged_by_admin_user_id AS "acknowledgedByAdminUserId",
        COALESCE(NULLIF(TRIM(ack_admin.full_name), ''), ack_admin.username, '') AS "acknowledgedByAdminName",
        ack_admin.username AS "acknowledgedByAdminUsername",
        ir.happened_at AS "happenedAt",
        ir.reported_at AS "reportedAt",
        ir.acknowledged_at AS "acknowledgedAt",
        ir.closed_at AS "closedAt",
        ir.status,
        ir.smartcard_session_id AS "smartcardSessionId",
        ir.dispense_attempt_id AS "dispenseAttemptId",
        ir.note_text AS "noteText",
        to_jsonb(ir) ->> 'deleted_at' AS "deletedAt",
        to_jsonb(ir) ->> 'deleted_by_admin_user_id' AS "deletedByAdminUserId",
        COALESCE(NULLIF(TRIM(del_admin.full_name), ''), del_admin.username, '') AS "deletedByAdminName",
        del_admin.username AS "deletedByAdminUsername",
        to_jsonb(ir) ->> 'delete_reason_text' AS "deleteReasonText",
        ir.created_at AS "createdAt",
        ir.updated_at AS "updatedAt"
      FROM incident_reports ir
      JOIN users reporter ON reporter.id = ir.reporter_user_id
      LEFT JOIN users ack_admin ON ack_admin.id = ir.acknowledged_by_admin_user_id
      LEFT JOIN users del_admin ON del_admin.id = NULLIF(to_jsonb(ir) ->> 'deleted_by_admin_user_id', '')::uuid
      WHERE ir.id = $1::uuid
      LIMIT 1
    `,
    [incidentId]
  );

  const incident = headerResult.rows[0];
  if (!incident) {
    return null;
  }

  const itemsResult = await db.query(
    `
      SELECT
        iri.id,
        iri.line_no AS "lineNo",
        iri.product_id AS "productId",
        iri.lot_id AS "lotId",
        iri.unit_level_id AS "unitLevelId",
        iri.product_code_snapshot AS "productCodeSnapshot",
        iri.product_name_snapshot AS "productNameSnapshot",
        iri.lot_no_snapshot AS "lotNoSnapshot",
        iri.exp_date_snapshot::text AS "expDateSnapshot",
        iri.qty,
        iri.unit_label_snapshot AS "unitLabelSnapshot",
        iri.note_text AS "noteText"
      FROM incident_report_items iri
      WHERE iri.incident_report_id = $1::uuid
      ORDER BY iri.line_no ASC, iri.created_at ASC
    `,
    [incidentId]
  );

  const resolutionActionsResult =
    (await hasIncidentResolutionActionsTable(db))
      ? await db.query(
          `
            SELECT
              irra.id,
              irra.line_no AS "lineNo",
              irra.action_type AS "actionType",
              irra.product_id AS "productId",
              irra.lot_id AS "lotId",
              irra.unit_level_id AS "unitLevelId",
              irra.product_code_snapshot AS "productCodeSnapshot",
              irra.product_name_snapshot AS "productNameSnapshot",
              irra.lot_no_snapshot AS "lotNoSnapshot",
              irra.exp_date_snapshot::text AS "expDateSnapshot",
              irra.qty,
              irra.unit_label_snapshot AS "unitLabelSnapshot",
              irra.note_text AS "noteText",
              irra.patient_pid_snapshot AS "patientPidSnapshot",
              irra.patient_full_name_snapshot AS "patientFullNameSnapshot",
              irra.patient_english_name_snapshot AS "patientEnglishNameSnapshot",
              irra.patient_birth_date_snapshot::text AS "patientBirthDateSnapshot",
              irra.patient_sex_snapshot AS "patientSexSnapshot",
              irra.patient_card_issue_place_snapshot AS "patientCardIssuePlaceSnapshot",
              irra.patient_card_issued_date_snapshot::text AS "patientCardIssuedDateSnapshot",
              irra.patient_card_expiry_date_snapshot::text AS "patientCardExpiryDateSnapshot",
              irra.patient_address_text_snapshot AS "patientAddressTextSnapshot",
              irra.applied_stock_movement_id AS "appliedStockMovementId",
              irra.applied_dispense_header_id AS "appliedDispenseHeaderId",
              irra.applied_dispense_line_id AS "appliedDispenseLineId",
              irra.applied_by_user_id AS "appliedByUserId",
              COALESCE(NULLIF(TRIM(applier.full_name), ''), applier.username, '') AS "appliedByName",
              applier.username AS "appliedByUsername",
              irra.applied_at AS "appliedAt",
              irra.created_at AS "createdAt"
            FROM incident_report_resolution_actions irra
            LEFT JOIN users applier ON applier.id = irra.applied_by_user_id
            WHERE irra.incident_report_id = $1::uuid
            ORDER BY irra.line_no ASC, irra.created_at ASC
          `,
          [incidentId]
        )
      : { rows: [] };

  return {
    ...incident,
    items: itemsResult.rows.map((row) => ({
      ...row,
      qty: Number(row.qty),
    })),
    resolutionActions: resolutionActionsResult.rows.map((row) => ({
      ...row,
      qty: Number(row.qty),
    })),
  };
}

async function getIncidentSnapshotById(client, incidentId) {
  const result = await client.query(
    `
      SELECT row_to_json(ir)::jsonb AS snapshot
      FROM incident_reports ir
      WHERE ir.id = $1::uuid
      LIMIT 1
    `,
    [incidentId]
  );
  return result.rows[0]?.snapshot || null;
}

async function insertIncidentAdminAudit(client, {
  incidentId,
  actionType,
  previousSnapshot,
  nextSnapshot = null,
  reason,
  changedByUserId,
}) {
  await client.query(
    `
      INSERT INTO incident_report_admin_audits (
        incident_report_id,
        action_type,
        previous_snapshot,
        next_snapshot,
        reason_text,
        changed_by,
        changed_at
      )
      VALUES (
        $1::uuid,
        $2,
        $3::jsonb,
        $4::jsonb,
        $5,
        $6::uuid,
        now()
      )
    `,
    [
      incidentId,
      actionType,
      previousSnapshot,
      nextSnapshot,
      reason,
      changedByUserId,
    ]
  );
}

function buildIncidentDeleteReversalNote(incident, action, reason) {
  const parts = [
    `[incident-delete-reversal] ${toCleanText(incident?.incidentCode) || "-"}`,
    `action=${toCleanText(action?.actionType) || "-"}`,
  ];

  if (Number.isFinite(Number(action?.lineNo))) {
    parts.push(`line=${Number(action.lineNo)}`);
  }

  const trimmedReason = toCleanText(reason);
  if (trimmedReason) {
    parts.push(`reason=${trimmedReason}`);
  }

  return parts.join(" | ");
}

async function reverseIncidentResolutionActionsForDelete(
  client,
  { incident, deletedByUserId, deletedAt, reason }
) {
  const actions = Array.isArray(incident?.resolutionActions) ? incident.resolutionActions : [];
  if (!actions.length) {
    return [];
  }

  const retrospectiveAction = actions.find(
    (action) =>
      toCleanText(action?.actionType).toUpperCase() === "RETROSPECTIVE_DISPENSE" ||
      action?.appliedDispenseHeaderId ||
      action?.appliedDispenseLineId
  );
  if (retrospectiveAction) {
    throw httpError(
      409,
      "Incident reports with retrospective dispense corrective actions cannot be deleted automatically; void the linked dispense record first"
    );
  }

  const baseUnitLevelIdByProductId = new Map();
  const reversalSummaries = [];
  const reversibleActions = [...actions].sort(
    (left, right) => (Number(right?.lineNo) || 0) - (Number(left?.lineNo) || 0)
  );

  for (const action of reversibleActions) {
    const actionType = toCleanText(action?.actionType).toUpperCase();
    const lineLabel = Number(action?.lineNo) || "-";
    if (!["STOCK_IN", "STOCK_OUT"].includes(actionType)) {
      throw httpError(409, `Unsupported incident corrective action for delete reversal: ${actionType || "-"}`);
    }

    const movementId = toCleanText(action?.appliedStockMovementId);
    if (!movementId || !isUuid(movementId)) {
      throw httpError(
        409,
        `Resolution action line ${lineLabel} is missing its applied stock movement reference`
      );
    }

    const movementResult = await client.query(
      `
        SELECT
          sm.id,
          sm.movement_type AS "movementType",
          sm.from_location_id AS "fromLocationId",
          sm.to_location_id AS "toLocationId",
          sm.product_id AS "productId",
          sm.lot_id AS "lotId",
          sm.quantity,
          sm.quantity_base AS "quantityBase",
          sm.unit_level_id AS "unitLevelId",
          sm.source_ref_type AS "sourceRefType",
          sm.source_ref_id AS "sourceRefId"
        FROM stock_movements sm
        WHERE sm.id = $1::uuid
        LIMIT 1
      `,
      [movementId]
    );

    const movement = movementResult.rows[0];
    if (!movement) {
      throw httpError(
        409,
        `Applied stock movement for resolution action line ${lineLabel} no longer exists`
      );
    }

    const expectedMovementType = actionType === "STOCK_IN" ? "RECEIVE" : "DISPENSE";
    if (movement.movementType !== expectedMovementType) {
      throw httpError(
        409,
        `Resolution action line ${lineLabel} cannot be reversed because its movement type is ${movement.movementType || "-"}`
      );
    }

    if (
      toCleanText(movement.sourceRefType) !== INCIDENT_SOURCE_REF_TYPE ||
      toCleanText(movement.sourceRefId) !== toCleanText(incident?.id)
    ) {
      throw httpError(
        409,
        `Resolution action line ${lineLabel} is linked to an unexpected stock source`
      );
    }

    const reversedDeltaQtyBase = -Number(movement.quantityBase);
    if (!Number.isFinite(reversedDeltaQtyBase) || reversedDeltaQtyBase === 0) {
      throw httpError(
        500,
        `Resolution action line ${lineLabel} has an invalid stored stock quantity`
      );
    }

    const branchId = movement.toLocationId || movement.fromLocationId;
    if (!branchId || !isUuid(branchId)) {
      throw httpError(
        500,
        `Resolution action line ${lineLabel} has an invalid stock branch reference`
      );
    }

    let baseUnitLevelId = baseUnitLevelIdByProductId.get(movement.productId);
    if (!baseUnitLevelId) {
      const baseUnitLevel = await resolveProductBaseUnitLevel(client, movement.productId);
      baseUnitLevelId = baseUnitLevel.id;
      baseUnitLevelIdByProductId.set(movement.productId, baseUnitLevelId);
    }

    try {
      await applyStockDelta(client, {
        branchId,
        productId: movement.productId,
        lotId: movement.lotId || null,
        baseUnitLevelId,
        deltaQtyBase: reversedDeltaQtyBase,
      });
    } catch (error) {
      if (error?.status === 400 && error?.message === "Insufficient stock for requested movement") {
        throw httpError(
          409,
          `Incident cannot be deleted because reversing resolution action line ${lineLabel} would make stock negative`
        );
      }
      throw error;
    }

    const reversalMovementType = reversedDeltaQtyBase > 0 ? "RECEIVE" : "DISPENSE";
    const reversalMovementResult = await client.query(
      `
        INSERT INTO stock_movements (
          movement_type,
          from_location_id,
          to_location_id,
          product_id,
          lot_id,
          quantity,
          quantity_base,
          unit_level_id,
          source_ref_type,
          source_ref_id,
          occurred_at,
          created_by,
          note_text
        )
        VALUES (
          $1::movement_type,
          $2::uuid,
          $3::uuid,
          $4::uuid,
          $5::uuid,
          $6,
          $7,
          $8::uuid,
          $9,
          $10::uuid,
          $11::timestamptz,
          $12::uuid,
          $13
        )
        RETURNING id, movement_type AS "movementType", quantity_base AS "quantityBase"
      `,
      [
        reversalMovementType,
        reversalMovementType === "DISPENSE" ? branchId : null,
        reversalMovementType === "RECEIVE" ? branchId : null,
        movement.productId,
        movement.lotId || null,
        movement.quantity,
        Math.abs(Number(movement.quantityBase)),
        movement.unitLevelId,
        INCIDENT_SOURCE_REF_TYPE,
        incident.id,
        deletedAt,
        deletedByUserId,
        buildIncidentDeleteReversalNote(incident, action, reason),
      ]
    );

    reversalSummaries.push({
      lineNo: Number(action?.lineNo) || null,
      actionType,
      originalMovementId: movement.id,
      reversalMovementId: reversalMovementResult.rows[0]?.id || null,
      reversalMovementType: reversalMovementResult.rows[0]?.movementType || reversalMovementType,
      reversedDeltaQtyBase,
    });
  }

  return reversalSummaries.sort((left, right) => (left.lineNo || 0) - (right.lineNo || 0));
}

function hasBodyField(body = {}, fieldNames = []) {
  return fieldNames.some((fieldName) => Object.prototype.hasOwnProperty.call(body, fieldName));
}

export async function createIncidentReport(req, res) {
  const reporterUserId = toCleanText(req.user?.id);
  if (!reporterUserId || !isUuid(reporterUserId)) {
    throw httpError(401, "Authentication required");
  }

  const incidentType = normalizeRequiredText(req.body?.incidentType ?? req.body?.incident_type, 80, "incidentType");
  const incidentReason = normalizeRequiredText(
    req.body?.incidentReason ?? req.body?.incident_reason,
    160,
    "incidentReason"
  );
  const incidentDescription = normalizeRequiredText(
    req.body?.incidentDescription ?? req.body?.incident_description,
    4000,
    "incidentDescription"
  );
  const happenedAt = toIsoTimestamp(req.body?.happenedAt ?? req.body?.happened_at);
  const status = normalizeIncidentStatus(req.body?.status, { defaultValue: "ACKNOWLEDGED" });
  const noteText = normalizeOptionalText(req.body?.note ?? req.body?.noteText ?? req.body?.note_text, 4000, "note");
  const smartcardSessionId = normalizeOptionalText(
    req.body?.smartcardSessionId ?? req.body?.smartcard_session_id,
    120,
    "smartcardSessionId"
  );
  const dispenseAttemptId = normalizeOptionalText(
    req.body?.dispenseAttemptId ?? req.body?.dispense_attempt_id,
    120,
    "dispenseAttemptId"
  );
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
  const normalizedItems = rawItems.map((item, index) => normalizeIncidentItemInput(item, index));
  const { resolutionActions, resolutionPatient } = normalizeIncidentResolutionPayload(req.body);

  const createdIncident = await withTransaction(async (client) => {
    if (resolutionActions.length && !(await hasIncidentResolutionActionsTable(client))) {
      throw httpError(503, "incident resolution actions table is not deployed yet; run migration 0022 first");
    }

    const branch = await resolveIncidentBranch(client, req.body);
    const nowIso = new Date().toISOString();
    const statusState = deriveStatusStateForCreate(status, reporterUserId, nowIso);
    const sequenceResult = await client.query(
      `SELECT nextval('incident_report_running_no_seq') AS running_no`
    );
    const runningNo = Number(sequenceResult.rows[0]?.running_no || 0);
    if (!Number.isFinite(runningNo) || runningNo <= 0) {
      throw httpError(500, "Unable to allocate incident running number");
    }
    const incidentCode = buildIncidentCode(runningNo);

    const headerResult = await client.query(
      `
        INSERT INTO incident_reports (
          running_no,
          incident_code,
          incident_type,
          incident_reason,
          incident_description,
          branch_id,
          branch_code_snapshot,
          branch_name_snapshot,
          reporter_user_id,
          acknowledged_by_admin_user_id,
          happened_at,
          reported_at,
          acknowledged_at,
          closed_at,
          status,
          smartcard_session_id,
          dispense_attempt_id,
          note_text,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6::uuid,
          $7,
          $8,
          $9::uuid,
          $10::uuid,
          $11::timestamptz,
          now(),
          $12::timestamptz,
          $13::timestamptz,
          $14,
          $15,
          $16,
          $17,
          now(),
          now()
        )
        RETURNING id
      `,
      [
        runningNo,
        incidentCode,
        incidentType,
        incidentReason,
        incidentDescription,
        branch.id,
        branch.code,
        branch.name,
        reporterUserId,
        statusState.acknowledgedByAdminUserId,
        happenedAt,
        statusState.acknowledgedAt,
        statusState.closedAt,
        status,
        smartcardSessionId,
        dispenseAttemptId,
        noteText,
      ]
    );

    const incidentId = headerResult.rows[0].id;

    for (const [index, item] of normalizedItems.entries()) {
      const product = await resolveIncidentProductSnapshot(client, item.productId);
      const lot = await resolveIncidentLotSnapshot(client, item.productId, item.lotId);
      const unitLevel = await resolveIncidentUnitSnapshot(client, item.productId, item.unitLevelId);

      await client.query(
        `
          INSERT INTO incident_report_items (
            incident_report_id,
            line_no,
            product_id,
            lot_id,
            unit_level_id,
            product_code_snapshot,
            product_name_snapshot,
            lot_no_snapshot,
            exp_date_snapshot,
            qty,
            unit_label_snapshot,
            note_text,
            created_at
          )
          VALUES (
            $1::uuid,
            $2,
            $3::uuid,
            $4::uuid,
            $5::uuid,
            $6,
            $7,
            $8,
            $9::date,
            $10,
            $11,
            $12,
            now()
          )
        `,
        [
          incidentId,
          index + 1,
          item.productId,
          lot?.id || null,
          unitLevel?.id || null,
          toCleanText(product.productCode) || null,
          toCleanText(product.tradeName) || "-",
          lot?.lotNo || item.lotNoSnapshot || null,
          lot?.expDate || item.expDateSnapshot || null,
          item.qty,
          unitLevel?.unitLabel || item.unitLabel || null,
          item.note,
        ]
      );
    }

    if (resolutionActions.length) {
      const incidentSeed = {
        id: incidentId,
        incidentCode,
        branchId: branch.id,
        branchCode: branch.code,
        branchName: branch.name,
        happenedAt,
        noteText,
        resolutionActions: [],
      };

      await applyIncidentResolutionActions(client, {
        incident: incidentSeed,
        resolutionActions,
        resolutionPatient,
        appliedByUserId: reporterUserId,
      });
    }

    const detail = await getIncidentDetailById(client, incidentId);
    if (!detail) {
      throw httpError(500, "Incident report was created but could not be loaded");
    }
    return detail;
  });

  return res.status(201).json({
    ok: true,
    incident: createdIncident,
  });
}

export async function listIncidentReports(req, res) {
  const fromDate = normalizeIncidentDateFilterStart(req.query.fromDate ?? req.query.from_date);
  const toDateExclusive = normalizeIncidentDateFilterEndExclusive(req.query.toDate ?? req.query.to_date);
  const branchCode = normalizeOptionalText(req.query.branchCode ?? req.query.branch_code, 30, "branchCode");
  const incidentType = normalizeOptionalText(req.query.incidentType ?? req.query.incident_type, 80, "incidentType");
  const status = normalizeIncidentStatus(req.query.status, { allowEmpty: true });
  const includeDeleted = parseBoolean(req.query.includeDeleted ?? req.query.include_deleted, false);
  const limit = normalizeListLimit(req.query.limit);

  const params = [];
  const where = [];

  if (!includeDeleted) {
    where.push(`(to_jsonb(ir) ->> 'deleted_at') IS NULL`);
  }

  if (fromDate) {
    params.push(fromDate);
    where.push(`ir.happened_at >= $${params.length}::timestamptz`);
  }
  if (toDateExclusive) {
    params.push(toDateExclusive);
    where.push(`ir.happened_at < $${params.length}::timestamptz`);
  }
  if (branchCode) {
    params.push(branchCode);
    where.push(`ir.branch_code_snapshot = $${params.length}`);
  }
  if (incidentType) {
    params.push(incidentType);
    where.push(`ir.incident_type = $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`ir.status = $${params.length}`);
  }

  params.push(limit);
  const result = await query(
    `
      SELECT
        ir.id,
        ir.incident_code AS "incidentCode",
        ir.incident_type AS "incidentType",
        ir.incident_reason AS "incidentReason",
        ir.incident_description AS "incidentDescription",
        ir.branch_code_snapshot AS "branchCode",
        ir.branch_name_snapshot AS "branchName",
        ir.happened_at AS "happenedAt",
        ir.reported_at AS "reportedAt",
        ir.status,
        to_jsonb(ir) ->> 'deleted_at' AS "deletedAt",
        to_jsonb(ir) ->> 'delete_reason_text' AS "deleteReasonText",
        COALESCE(NULLIF(TRIM(reporter.full_name), ''), reporter.username, 'unknown') AS "reporterName",
        reporter.username AS "reporterUsername",
        COALESCE(item_count.item_count, 0) AS "itemCount"
      FROM incident_reports ir
      JOIN users reporter ON reporter.id = ir.reporter_user_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS item_count
        FROM incident_report_items iri
        WHERE iri.incident_report_id = ir.id
      ) item_count ON true
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ir.happened_at DESC, ir.running_no DESC
      LIMIT $${params.length}
    `,
    params
  );

  return res.json({
    items: result.rows.map((row) => ({
      ...row,
      itemCount: Number(row.itemCount || 0),
    })),
  });
}

export async function getIncidentReportById(req, res) {
  const incidentId = toCleanText(req.params.id);
  if (!incidentId || !isUuid(incidentId)) {
    throw httpError(400, "incident id must be a valid UUID");
  }

  const incident = await getIncidentDetailById({ query }, incidentId);
  if (!incident) {
    throw httpError(404, "Incident report not found");
  }

  const userRole = toCleanText(req.user?.role).toUpperCase();
  if (userRole !== "ADMIN") {
    const userLocationId = toCleanText(req.user?.location_id);
    const userBranchCode = toCleanText(req.user?.branchCode ?? req.user?.branch_code);
    const canViewBranch =
      (userLocationId && toCleanText(incident.branchId) === userLocationId) ||
      (userBranchCode && toCleanText(incident.branchCode) === userBranchCode);
    if (!canViewBranch) {
      throw httpError(403, "Forbidden: incident report is outside your branch");
    }
  }

  return res.json({
    incident,
  });
}

export async function applyIncidentReportResolution(req, res) {
  const incidentId = toCleanText(req.params.id);
  const adminUserId = toCleanText(req.user?.id);
  if (!incidentId || !isUuid(incidentId)) {
    throw httpError(400, "incident id must be a valid UUID");
  }
  if (!adminUserId || !isUuid(adminUserId)) {
    throw httpError(401, "Authentication required");
  }

  const { resolutionActions, resolutionPatient } = normalizeIncidentResolutionPayload(req.body);
  if (!resolutionActions.length) {
    throw httpError(400, "resolutionActions must contain at least one item");
  }

  const updatedIncident = await withTransaction(async (client) => {
    if (!(await hasIncidentResolutionActionsTable(client))) {
      throw httpError(503, "incident resolution actions table is not deployed yet; run migration 0022 first");
    }

    const existing = await getIncidentDetailById(client, incidentId);
    if (!existing) {
      throw httpError(404, "Incident report not found");
    }
    if (existing.deletedAt) {
      throw httpError(409, "Deleted incident reports cannot receive corrective actions");
    }

    await applyIncidentResolutionActions(client, {
      incident: existing,
      resolutionActions,
      resolutionPatient,
      appliedByUserId: adminUserId,
    });

    const detail = await getIncidentDetailById(client, incidentId);
    if (!detail) {
      throw httpError(500, "Incident resolution was applied but could not be loaded");
    }
    return detail;
  });

  return res.json({
    ok: true,
    incident: updatedIncident,
  });
}

export async function updateIncidentReport(req, res) {
  const incidentId = toCleanText(req.params.id);
  const adminUserId = toCleanText(req.user?.id);
  if (!incidentId || !isUuid(incidentId)) {
    throw httpError(400, "incident id must be a valid UUID");
  }
  if (!adminUserId || !isUuid(adminUserId)) {
    throw httpError(401, "Authentication required");
  }

  const reason = normalizeRequiredText(
    req.body?.reason ?? req.body?.reasonText ?? req.body?.reason_text,
    4000,
    "reason"
  );
  const body = req.body || {};

  const updatedIncident = await withTransaction(async (client) => {
    requireIncidentAdminAuditSchemaAvailable(await hasIncidentAdminAuditsTable(client));

    const existing = await getIncidentDetailById(client, incidentId);
    if (!existing) {
      throw httpError(404, "Incident report not found");
    }
    if (existing.deletedAt) {
      throw httpError(409, "Deleted incident reports cannot be edited");
    }

    const previousSnapshot = await getIncidentSnapshotById(client, incidentId);
    if (!previousSnapshot) {
      throw httpError(404, "Incident report not found");
    }

    const nextIncidentType = hasBodyField(body, ["incidentType", "incident_type"])
      ? normalizeRequiredText(body.incidentType ?? body.incident_type, 80, "incidentType")
      : existing.incidentType;
    const nextIncidentReason = hasBodyField(body, ["incidentReason", "incident_reason"])
      ? normalizeRequiredText(body.incidentReason ?? body.incident_reason, 160, "incidentReason")
      : existing.incidentReason;
    const nextIncidentDescription = hasBodyField(body, ["incidentDescription", "incident_description"])
      ? normalizeRequiredText(
          body.incidentDescription ?? body.incident_description,
          4000,
          "incidentDescription"
        )
      : existing.incidentDescription;
    const nextHappenedAt = hasBodyField(body, ["happenedAt", "happened_at"])
      ? toIsoTimestamp(body.happenedAt ?? body.happened_at)
      : existing.happenedAt;
    const nextStatus = hasBodyField(body, ["status"])
      ? normalizeIncidentStatus(body.status, { defaultValue: existing.status || "ACKNOWLEDGED" })
      : existing.status;
    const nextNoteText = hasBodyField(body, ["note", "noteText", "note_text"])
      ? normalizeOptionalText(body.note ?? body.noteText ?? body.note_text, 4000, "note")
      : existing.noteText || null;

    const timestamp = new Date().toISOString();
    const statusState = deriveStatusStateForUpdate(existing, nextStatus, adminUserId, timestamp);

    await client.query(
      `
        UPDATE incident_reports
        SET incident_type = $2,
            incident_reason = $3,
            incident_description = $4,
            happened_at = $5::timestamptz,
            status = $6,
            acknowledged_by_admin_user_id = $7::uuid,
            acknowledged_at = $8::timestamptz,
            closed_at = $9::timestamptz,
            note_text = $10,
            updated_at = now()
        WHERE id = $1::uuid
      `,
      [
        incidentId,
        nextIncidentType,
        nextIncidentReason,
        nextIncidentDescription,
        nextHappenedAt,
        nextStatus,
        statusState.acknowledgedByAdminUserId,
        statusState.acknowledgedAt,
        statusState.closedAt,
        nextNoteText,
      ]
    );

    const nextSnapshot = await getIncidentSnapshotById(client, incidentId);
    await insertIncidentAdminAudit(client, {
      incidentId,
      actionType: "UPDATE",
      previousSnapshot,
      nextSnapshot,
      reason,
      changedByUserId: adminUserId,
    });

    const detail = await getIncidentDetailById(client, incidentId);
    if (!detail) {
      throw httpError(500, "Incident report was updated but could not be loaded");
    }
    return detail;
  });

  return res.json({
    ok: true,
    incident: updatedIncident,
  });
}

export async function deleteIncidentReport(req, res) {
  const incidentId = toCleanText(req.params.id);
  const adminUserId = toCleanText(req.user?.id);
  if (!incidentId || !isUuid(incidentId)) {
    throw httpError(400, "incident id must be a valid UUID");
  }
  if (!adminUserId || !isUuid(adminUserId)) {
    throw httpError(401, "Authentication required");
  }

  const reason = normalizeRequiredText(
    req.body?.reason ?? req.body?.reasonText ?? req.body?.reason_text,
    4000,
    "reason"
  );

  const deletedIncident = await withTransaction(async (client) => {
    requireIncidentAdminAuditSchemaAvailable(await hasIncidentAdminAuditsTable(client));

    const existing = await getIncidentDetailById(client, incidentId);
    if (!existing) {
      throw httpError(404, "Incident report not found");
    }
    if (existing.deletedAt) {
      throw httpError(409, "Incident report is already deleted");
    }

    const previousSnapshot = await getIncidentSnapshotById(client, incidentId);
    if (!previousSnapshot) {
      throw httpError(404, "Incident report not found");
    }

    const timestamp = new Date().toISOString();
    const statusState = deriveStatusStateForUpdate(existing, "CLOSED", adminUserId, timestamp);
    const reversedResolutionActions = await reverseIncidentResolutionActionsForDelete(client, {
      incident: existing,
      deletedByUserId: adminUserId,
      deletedAt: timestamp,
      reason,
    });

    await client.query(
      `
        UPDATE incident_reports
        SET status = 'CLOSED',
            acknowledged_by_admin_user_id = $2::uuid,
            acknowledged_at = $3::timestamptz,
            closed_at = $4::timestamptz,
            deleted_at = $5::timestamptz,
            deleted_by_admin_user_id = $2::uuid,
            delete_reason_text = $6,
            updated_at = now()
        WHERE id = $1::uuid
      `,
      [
        incidentId,
        statusState.acknowledgedByAdminUserId,
        statusState.acknowledgedAt,
        statusState.closedAt,
        timestamp,
        reason,
      ]
    );

    const nextSnapshot = await getIncidentSnapshotById(client, incidentId);
    await insertIncidentAdminAudit(client, {
      incidentId,
      actionType: "DELETE",
      previousSnapshot,
      nextSnapshot,
      reason,
      changedByUserId: adminUserId,
    });

    const detail = await getIncidentDetailById(client, incidentId);
    if (!detail) {
      throw httpError(500, "Incident report was deleted but could not be loaded");
    }
    return {
      ...detail,
      reversedResolutionActions,
    };
  });

  return res.json({
    ok: true,
    incident: deletedIncident,
  });
}

export async function updateIncidentReportStatus(req, res) {
  const incidentId = toCleanText(req.params.id);
  const adminUserId = toCleanText(req.user?.id);
  if (!incidentId || !isUuid(incidentId)) {
    throw httpError(400, "incident id must be a valid UUID");
  }
  if (!adminUserId || !isUuid(adminUserId)) {
    throw httpError(401, "Authentication required");
  }

  const nextStatus = normalizeIncidentStatus(req.body?.status, { defaultValue: "ACKNOWLEDGED" });

  const updatedIncident = await withTransaction(async (client) => {
    const existing = await getIncidentDetailById(client, incidentId);
    if (!existing) {
      throw httpError(404, "Incident report not found");
    }
    if (existing.deletedAt) {
      throw httpError(409, "Deleted incident reports cannot be updated");
    }

    const timestamp = new Date().toISOString();
    const statusState = deriveStatusStateForUpdate(existing, nextStatus, adminUserId, timestamp);

    await client.query(
      `
        UPDATE incident_reports
        SET status = $2,
            acknowledged_by_admin_user_id = $3::uuid,
            acknowledged_at = $4::timestamptz,
            closed_at = $5::timestamptz,
            updated_at = now()
        WHERE id = $1::uuid
      `,
      [
        incidentId,
        nextStatus,
        statusState.acknowledgedByAdminUserId,
        statusState.acknowledgedAt,
        statusState.closedAt,
      ]
    );

    const detail = await getIncidentDetailById(client, incidentId);
    if (!detail) {
      throw httpError(500, "Incident report was updated but could not be loaded");
    }
    return detail;
  });

  return res.json({
    ok: true,
    incident: updatedIncident,
  });
}
