import { query, withTransaction } from "../db/pool.js";
import {
  applyStockDelta,
  assertLotBelongsToProduct,
  assertUnitLevelAllowedForLot,
  convertToBase,
  resolveActorUserId,
  resolveProductBaseUnitLevel,
} from "./helpers.js";
import { httpError } from "../utils/httpError.js";

let hasDispenseLineLotCorrectionAuditsTableCache = null;

function toCleanText(value) {
  return String(value ?? "").trim();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    toCleanText(value)
  );
}

function normalizeRequiredText(value, maxLength, fieldName) {
  const text = toCleanText(value);
  if (!text) {
    throw httpError(400, `${fieldName} is required`);
  }
  if (maxLength && text.length > maxLength) {
    throw httpError(400, `${fieldName} must be at most ${maxLength} characters`);
  }
  return text;
}

function numericOrZero(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatBaseQuantity(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  return numeric.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}

async function hasDispenseLineLotCorrectionAuditsTable(client) {
  if (hasDispenseLineLotCorrectionAuditsTableCache === true) {
    return true;
  }

  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'dispense_line_lot_correction_audits'
      LIMIT 1
    `
  );

  if (result.rows[0]) {
    hasDispenseLineLotCorrectionAuditsTableCache = true;
    return true;
  }

  return false;
}

async function getDispenseLineCoreById(client, dispenseLineId, { forUpdate = false } = {}) {
  const lockClause = forUpdate ? "FOR UPDATE OF dl, dh" : "";
  const result = await client.query(
    `
      SELECT
        dl.id,
        dl.header_id AS "headerId",
        dl.line_no AS "lineNo",
        dl.product_id AS "productId",
        dl.lot_id AS "lotId",
        dl.unit_level_id AS "unitLevelId",
        dl.quantity,
        dl.note_text AS "lineNote",
        dl.created_at AS "lineCreatedAt",
        dh.branch_id AS "branchId",
        dh.patient_id AS "patientId",
        dh.dispensed_at AS "dispensedAt",
        dh.note_text AS "headerNote",
        branch.code AS "branchCode",
        branch.name AS "branchName",
        branch.location_type AS "branchLocationType",
        p.product_code AS "productCode",
        p.trade_name AS "tradeName",
        pul.display_name AS "unitDisplayName",
        pul.code AS "unitCode",
        pul.unit_key AS "unitKey",
        old_lot.lot_no AS "lotNo",
        old_lot.exp_date::text AS "lotExpDate",
        old_lot.mfg_date::text AS "lotMfgDate",
        old_lot.manufacturer_name AS "lotManufacturerName",
        patient.pid AS "patientPid",
        patient.full_name AS "patientFullName"
      FROM dispense_lines dl
      JOIN dispense_headers dh ON dh.id = dl.header_id
      JOIN locations branch ON branch.id = dh.branch_id
      JOIN products p ON p.id = dl.product_id
      JOIN product_unit_levels pul ON pul.id = dl.unit_level_id
      LEFT JOIN product_lots old_lot ON old_lot.id = dl.lot_id
      LEFT JOIN patients patient ON patient.id = dh.patient_id
      WHERE dl.id = $1::uuid
      LIMIT 1
      ${lockClause}
    `,
    [dispenseLineId]
  );

  return result.rows[0] || null;
}

async function getDispenseLineStockMovements(client, dispenseLineId, { forUpdate = false } = {}) {
  const lockClause = forUpdate ? "FOR UPDATE" : "";
  const result = await client.query(
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
        sm.source_ref_id AS "sourceRefId",
        sm.occurred_at AS "occurredAt",
        sm.corrected_occurred_at AS "correctedOccurredAt",
        sm.note_text AS "noteText",
        sm.created_at AS "createdAt",
        row_to_json(sm)::jsonb AS snapshot
      FROM stock_movements sm
      WHERE sm.dispense_line_id = $1::uuid
      ORDER BY sm.created_at ASC, sm.id ASC
      ${lockClause}
    `,
    [dispenseLineId]
  );

  return result.rows;
}

async function getDispenseMovementLinkById(client, movementId, { forUpdate = false } = {}) {
  const lockClause = forUpdate ? "FOR UPDATE" : "";
  const result = await client.query(
    `
      SELECT
        sm.id,
        sm.dispense_line_id AS "dispenseLineId",
        sm.movement_type AS "movementType",
        sm.source_ref_type AS "sourceRefType",
        sm.source_ref_id AS "sourceRefId"
      FROM stock_movements sm
      WHERE sm.id = $1::uuid
      LIMIT 1
      ${lockClause}
    `,
    [movementId]
  );

  return result.rows[0] || null;
}

async function resolveDispenseLineIdFromMovementId(client, movementId, { forUpdate = false } = {}) {
  const movement = await getDispenseMovementLinkById(client, movementId, { forUpdate });
  if (!movement) {
    throw httpError(404, "Movement not found");
  }
  if (toCleanText(movement.movementType) !== "DISPENSE") {
    throw httpError(409, "This movement is not a DISPENSE movement");
  }
  if (!toCleanText(movement.dispenseLineId)) {
    throw httpError(409, "This movement is not linked to a dispense line");
  }

  return {
    movementId: movement.id,
    dispenseLineId: movement.dispenseLineId,
  };
}

function validateDispenseLineCorrectionState(detail) {
  if (!detail) {
    throw httpError(404, "Dispense line not found");
  }
  if (!detail.lotId) {
    throw httpError(409, "This dispense line does not have a stored lot_id to correct");
  }
  if (toCleanText(detail.branchLocationType).toUpperCase() !== "BRANCH") {
    throw httpError(409, "Dispense header branch is not a branch location");
  }

  const stockMovements = Array.isArray(detail.stockMovements) ? detail.stockMovements : [];
  if (stockMovements.length !== 1) {
    throw httpError(
      409,
      `Expected exactly one stock movement linked to this dispense line, found ${stockMovements.length}`
    );
  }

  const movement = stockMovements[0];
  if (toCleanText(movement.movementType) !== "DISPENSE") {
    throw httpError(409, "Linked stock movement is not a DISPENSE movement");
  }
  if (toCleanText(movement.productId) !== toCleanText(detail.productId)) {
    throw httpError(409, "Linked stock movement product does not match the dispense line");
  }
  if (toCleanText(movement.unitLevelId) !== toCleanText(detail.unitLevelId)) {
    throw httpError(409, "Linked stock movement unit level does not match the dispense line");
  }
  if (toCleanText(movement.fromLocationId) !== toCleanText(detail.branchId)) {
    throw httpError(409, "Linked stock movement branch does not match the dispense header branch");
  }
  if (toCleanText(movement.toLocationId)) {
    throw httpError(409, "Linked DISPENSE stock movement unexpectedly has a destination location");
  }
  if (toCleanText(movement.lotId) !== toCleanText(detail.lotId)) {
    throw httpError(409, "Linked stock movement lot does not match the dispense line lot");
  }

  return movement;
}

function buildCorrectionPreview(detail, movement, quantityBase) {
  return {
    dispenseLineId: detail.id,
    dispenseHeaderId: detail.headerId,
    stockMovementId: movement?.id || null,
    branchId: detail.branchId,
    branchCode: detail.branchCode,
    branchName: detail.branchName,
    patientId: detail.patientId || null,
    patientPid: detail.patientPid || null,
    patientFullName: detail.patientFullName || null,
    productId: detail.productId,
    productCode: detail.productCode,
    tradeName: detail.tradeName,
    unitLevelId: detail.unitLevelId,
    unitLabel: toCleanText(detail.unitDisplayName || detail.unitCode) || "unit",
    quantity: Number(detail.quantity),
    quantityBase,
    dispensedAt: detail.dispensedAt,
    oldLotId: detail.lotId,
    oldLotNo: detail.lotNo || null,
    oldLotExpDate: detail.lotExpDate || null,
    lineNo: Number(detail.lineNo || 0),
  };
}

async function getDispenseLineLotChoices(client, { branchId, productId, currentLotId }) {
  const result = await client.query(
    `
      SELECT
        pl.id,
        pl.lot_no AS "lotNo",
        pl.mfg_date::text AS "mfgDate",
        pl.exp_date::text AS "expDate",
        pl.manufacturer_name AS "manufacturerName",
        COALESCE(stock.quantity_on_hand_base, 0) AS "quantityOnHandBase"
      FROM product_lots pl
      LEFT JOIN LATERAL (
        SELECT SUM(soh.quantity_on_hand)::numeric AS quantity_on_hand_base
        FROM stock_on_hand soh
        WHERE soh.branch_id = $1::uuid
          AND soh.product_id = $2::uuid
          AND soh.lot_id = pl.id
      ) stock ON true
      WHERE pl.product_id = $2::uuid
      ORDER BY
        CASE WHEN pl.id = $3::uuid THEN 0 ELSE 1 END,
        COALESCE(stock.quantity_on_hand_base, 0) DESC,
        pl.exp_date DESC,
        pl.lot_no ASC
      LIMIT 100
    `,
    [branchId, productId, currentLotId || null]
  );

  return result.rows.map((row) => ({
    id: row.id,
    lotNo: row.lotNo || "",
    mfgDate: row.mfgDate || null,
    expDate: row.expDate || null,
    manufacturerName: row.manufacturerName || null,
    quantityOnHandBase: Number(row.quantityOnHandBase || 0),
  }));
}

async function getLotSnapshot(client, { lotId, productId }) {
  const result = await client.query(
    `
      SELECT
        id,
        lot_no AS "lotNo",
        mfg_date::text AS "mfgDate",
        exp_date::text AS "expDate",
        manufacturer_name AS "manufacturerName"
      FROM product_lots
      WHERE id = $1::uuid
        AND product_id = $2::uuid
      LIMIT 1
    `,
    [lotId, productId]
  );

  return result.rows[0] || null;
}

async function getLockedStockOnHandBase(client, { branchId, productId, baseUnitLevelId, lotId }) {
  const result = await client.query(
    `
      SELECT id, quantity_on_hand
      FROM stock_on_hand
      WHERE branch_id = $1::uuid
        AND product_id = $2::uuid
        AND base_unit_level_id = $3::uuid
        AND lot_id IS NOT DISTINCT FROM $4::uuid
      FOR UPDATE
    `,
    [branchId, productId, baseUnitLevelId, lotId || null]
  );

  return result.rows[0] || null;
}

async function loadDispenseLineDetail(client, dispenseLineId, { forUpdate = false } = {}) {
  const core = await getDispenseLineCoreById(client, dispenseLineId, { forUpdate });
  if (!core) return null;

  const stockMovements = await getDispenseLineStockMovements(client, dispenseLineId, { forUpdate });
  return {
    ...core,
    stockMovements,
  };
}

async function buildDispenseLineResponse(client, dispenseLineId, { forUpdate = false } = {}) {
  const detail = await loadDispenseLineDetail(client, dispenseLineId, { forUpdate });
  if (!detail) return null;

  let movement = null;
  let quantityBase = null;
  let correctionWarning = "";
  try {
    movement = validateDispenseLineCorrectionState(detail);
    const movementQuantityBase = Math.abs(Number(movement.quantityBase));
    const derivedQuantityBase = convertToBase(detail.quantity, {
      id: detail.unitLevelId,
      unit_key: detail.unitKey,
      display_name: detail.unitDisplayName,
      code: detail.unitCode,
    });

    if (!Number.isFinite(movementQuantityBase) || movementQuantityBase <= 0) {
      throw httpError(409, "Linked stock movement is missing a valid quantity_base value");
    }
    if (Math.abs(movementQuantityBase - derivedQuantityBase) > 0.0001) {
      throw httpError(
        409,
        "Linked stock movement quantity does not match the dispense line unit conversion"
      );
    }
    quantityBase = movementQuantityBase;
  } catch (error) {
    correctionWarning = error?.message || "Dispense line is not in a correctable state";
  }

  const availableLots = await getDispenseLineLotChoices(client, {
    branchId: detail.branchId,
    productId: detail.productId,
    currentLotId: detail.lotId,
  });

  return {
    dispenseLine: {
      id: detail.id,
      headerId: detail.headerId,
      lineNo: Number(detail.lineNo || 0),
      productId: detail.productId,
      productCode: detail.productCode,
      tradeName: detail.tradeName,
      lotId: detail.lotId || null,
      lotNo: detail.lotNo || null,
      lotExpDate: detail.lotExpDate || null,
      lotMfgDate: detail.lotMfgDate || null,
      unitLevelId: detail.unitLevelId,
      unitLabel: toCleanText(detail.unitDisplayName || detail.unitCode) || "unit",
      quantity: Number(detail.quantity),
      quantityBase: quantityBase ?? null,
      branchId: detail.branchId,
      branchCode: detail.branchCode,
      branchName: detail.branchName,
      dispensedAt: detail.dispensedAt,
      patientId: detail.patientId || null,
      patientPid: detail.patientPid || null,
      patientFullName: detail.patientFullName || null,
      lineNote: detail.lineNote || null,
      headerNote: detail.headerNote || null,
    },
    linkedStockMovement: movement
      ? {
          id: movement.id,
          movementType: movement.movementType,
          fromLocationId: movement.fromLocationId,
          toLocationId: movement.toLocationId,
          lotId: movement.lotId,
          quantity: Number(movement.quantity),
          quantityBase: Number(movement.quantityBase),
          sourceRefType: movement.sourceRefType || null,
          sourceRefId: movement.sourceRefId || null,
          occurredAt: movement.correctedOccurredAt || movement.occurredAt,
          originalOccurredAt: movement.occurredAt,
          correctedOccurredAt: movement.correctedOccurredAt || null,
        }
      : null,
    availableLots,
    canCorrect: !correctionWarning,
    correctionWarning: correctionWarning || null,
  };
}

export async function correctDispenseMovementLotInternal(
  client,
  { movementId, newLotId, reason, adminUserId }
) {
  const normalizedMovementId = toCleanText(movementId);
  const normalizedNewLotId = toCleanText(newLotId);
  const normalizedReason = normalizeRequiredText(reason, 4000, "reason");
  const normalizedAdminUserId = toCleanText(adminUserId);

  if (!normalizedMovementId || !isUuid(normalizedMovementId)) {
    throw httpError(400, "movement id must be a valid UUID");
  }
  if (!normalizedNewLotId || !isUuid(normalizedNewLotId)) {
    throw httpError(400, "newLotId must be a valid UUID");
  }
  if (!normalizedAdminUserId || !isUuid(normalizedAdminUserId)) {
    throw httpError(401, "Authentication required");
  }

  if (!(await hasDispenseLineLotCorrectionAuditsTable(client))) {
    throw httpError(
      503,
      "dispense line lot correction audit table is not deployed yet; run migration 0026 first"
    );
  }

  const correctedByUserId = await resolveActorUserId(client, normalizedAdminUserId);
  const resolved = await resolveDispenseLineIdFromMovementId(client, normalizedMovementId, {
    forUpdate: true,
  });
  const dispenseLineId = resolved.dispenseLineId;
  const detail = await loadDispenseLineDetail(client, dispenseLineId, { forUpdate: true });
  const movement = validateDispenseLineCorrectionState(detail);

  if (toCleanText(detail.lotId) === normalizedNewLotId) {
    throw httpError(400, "Old lot and new lot are the same");
  }

  await assertLotBelongsToProduct(client, detail.productId, normalizedNewLotId);
  await assertUnitLevelAllowedForLot(client, {
    productId: detail.productId,
    lotId: normalizedNewLotId,
    unitLevelId: detail.unitLevelId,
  });

  const oldLot = await getLotSnapshot(client, {
    lotId: detail.lotId,
    productId: detail.productId,
  });
  const newLot = await getLotSnapshot(client, {
    lotId: normalizedNewLotId,
    productId: detail.productId,
  });

  if (!oldLot) {
    throw httpError(409, "Current dispense line lot no longer exists");
  }
  if (!newLot) {
    throw httpError(404, "New lot was not found for this product");
  }

  const derivedQuantityBase = convertToBase(detail.quantity, {
    id: detail.unitLevelId,
    unit_key: detail.unitKey,
    display_name: detail.unitDisplayName,
    code: detail.unitCode,
  });
  const movementQuantityBase = Math.abs(Number(movement.quantityBase));
  if (!Number.isFinite(movementQuantityBase) || movementQuantityBase <= 0) {
    throw httpError(409, "Linked stock movement is missing a valid quantity_base value");
  }
  if (Math.abs(movementQuantityBase - derivedQuantityBase) > 0.0001) {
    throw httpError(
      409,
      "Linked stock movement quantity does not match the dispense line unit conversion"
    );
  }

  const baseUnitLevel = await resolveProductBaseUnitLevel(client, detail.productId);
  const lockedTargetStock = await getLockedStockOnHandBase(client, {
    branchId: detail.branchId,
    productId: detail.productId,
    baseUnitLevelId: baseUnitLevel.id,
    lotId: normalizedNewLotId,
  });
  const availableTargetQtyBase = numericOrZero(lockedTargetStock?.quantity_on_hand);
  if (availableTargetQtyBase < movementQuantityBase) {
    throw httpError(
      409,
      `Insufficient stock on target lot ${newLot.lotNo || newLot.id} at branch ${detail.branchCode || detail.branchId}: available ${formatBaseQuantity(
        availableTargetQtyBase
      )} base units, requires ${formatBaseQuantity(movementQuantityBase)}`
    );
  }

  const previousSnapshot = buildCorrectionPreview(detail, movement, movementQuantityBase);

  await applyStockDelta(client, {
    branchId: detail.branchId,
    productId: detail.productId,
    lotId: detail.lotId,
    baseUnitLevelId: baseUnitLevel.id,
    deltaQtyBase: movementQuantityBase,
  });
  await applyStockDelta(client, {
    branchId: detail.branchId,
    productId: detail.productId,
    lotId: normalizedNewLotId,
    baseUnitLevelId: baseUnitLevel.id,
    deltaQtyBase: -movementQuantityBase,
  });

  await client.query(
    `
      UPDATE dispense_lines
      SET lot_id = $2::uuid
      WHERE id = $1::uuid
    `,
    [dispenseLineId, normalizedNewLotId]
  );

  await client.query(
    `
      UPDATE stock_movements
      SET lot_id = $2::uuid
      WHERE id = $1::uuid
    `,
    [movement.id, normalizedNewLotId]
  );

  const nextSnapshot = {
    ...previousSnapshot,
    oldLotId: detail.lotId,
    oldLotNo: oldLot.lotNo || null,
    newLotId: normalizedNewLotId,
    newLotNo: newLot.lotNo || null,
    newLotExpDate: newLot.expDate || null,
  };

  const auditResult = await client.query(
    `
      INSERT INTO dispense_line_lot_correction_audits (
        dispense_line_id,
        dispense_header_id,
        stock_movement_id,
        product_id,
        branch_id,
        old_lot_id,
        new_lot_id,
        old_lot_no,
        new_lot_no,
        quantity,
        quantity_base,
        unit_level_id,
        reason_text,
        previous_snapshot,
        next_snapshot,
        corrected_by,
        corrected_at
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        $5::uuid,
        $6::uuid,
        $7::uuid,
        $8,
        $9,
        $10,
        $11,
        $12::uuid,
        $13,
        $14::jsonb,
        $15::jsonb,
        $16::uuid,
        now()
      )
      RETURNING id, corrected_at AS "correctedAt"
    `,
    [
      dispenseLineId,
      detail.headerId,
      movement.id,
      detail.productId,
      detail.branchId,
      detail.lotId,
      normalizedNewLotId,
      oldLot.lotNo || null,
      newLot.lotNo || null,
      detail.quantity,
      movementQuantityBase,
      detail.unitLevelId,
      normalizedReason,
      JSON.stringify(previousSnapshot),
      JSON.stringify(nextSnapshot),
      correctedByUserId,
    ]
  );

  const response = await buildDispenseLineResponse(client, dispenseLineId, { forUpdate: true });
  return {
    auditId: auditResult.rows[0]?.id || null,
    correctedAt: auditResult.rows[0]?.correctedAt || null,
    reason: normalizedReason,
    previous: previousSnapshot,
    current: response,
  };
}

export async function getDispenseMovementLotCorrectionDetail(req, res) {
  const movementId = toCleanText(req.params.id);
  if (!movementId || !isUuid(movementId)) {
    throw httpError(400, "movement id must be a valid UUID");
  }

  const resolved = await resolveDispenseLineIdFromMovementId({ query }, movementId);
  const payload = await buildDispenseLineResponse({ query }, resolved.dispenseLineId);
  if (!payload) {
    throw httpError(404, "Linked dispense line not found");
  }

  return res.json(payload);
}

export async function correctDispenseMovementLot(req, res) {
  const movementId = toCleanText(req.params.id);
  const newLotId = toCleanText(req.body?.newLotId ?? req.body?.new_lot_id);
  const reason = normalizeRequiredText(
    req.body?.reason ?? req.body?.reasonText ?? req.body?.reason_text,
    4000,
    "reason"
  );
  const adminUserId = toCleanText(req.user?.id || req.body?.correctedByUserId);

  if (!movementId || !isUuid(movementId)) {
    throw httpError(400, "movement id must be a valid UUID");
  }
  if (!newLotId || !isUuid(newLotId)) {
    throw httpError(400, "newLotId must be a valid UUID");
  }
  if (!adminUserId || !isUuid(adminUserId)) {
    throw httpError(401, "Authentication required");
  }

  const result = await withTransaction((client) =>
    correctDispenseMovementLotInternal(client, {
      movementId,
      newLotId,
      reason,
      adminUserId,
    })
  );

  return res.json({
    ok: true,
    ...result,
  });
}
