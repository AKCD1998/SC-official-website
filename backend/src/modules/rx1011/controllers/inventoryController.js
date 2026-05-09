import { randomUUID } from "crypto";
import { query, withTransaction } from "../db/pool.js";
import {
  applyStockDelta,
  assertLotBelongsToProduct,
  assertUnitLevelAllowedForLot,
  convertMovementToSignedBase,
  convertToBase,
  ensureLot,
  ensureProductExists,
  ensureProductUnitLevel,
  productUnitLevelsActiveCompatPredicate,
  resolveProductBaseUnitLevel,
  resolveActorUserId,
  resolveBranchById,
  resolveBranchByCode,
  toIsoTimestamp,
  toPositiveNumeric,
} from "./helpers.js";
import { httpError } from "../utils/httpError.js";
import { parseDateOnlyInput } from "../utils/dateOnly.js";

const MOVEMENT_TYPES = new Set(["RECEIVE", "TRANSFER_OUT", "DISPENSE"]);
const MOVEMENT_REPORT_TYPES = new Set(["RECEIVE", "TRANSFER_OUT", "TRANSFER_IN", "DISPENSE"]);
const TRANSFER_REQUEST_SOURCE_REF = "TRANSFER_REQUEST";
const TRANSFER_REQUEST_STATUSES = new Set(["PENDING", "ACCEPTED", "REJECTED"]);
let hasStockMovementDeleteAuditsTableCache = null;
const LOCATION_TYPES = new Set([
  "BRANCH",
  "OFFICE",
  "MANUFACTURER",
  "WHOLESALER",
  "VENDOR",
  "WAREHOUSE",
  "OTHER",
]);

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeRole(role) {
  return normalizeText(role).toUpperCase();
}

async function resolveAccessibleBranchCodeForStockRead({
  requestedBranchCode = "",
  user = {},
  requireBranchCodeForAdmin = false,
}) {
  const branchCode = normalizeText(requestedBranchCode);
  const userRole = normalizeRole(user?.role);
  const userLocationId = normalizeText(user?.location_id);

  if (userRole !== "ADMIN") {
    if (!userLocationId) {
      throw httpError(403, "Branch-scoped access requires location_id");
    }

    const viewerBranch = await resolveBranchById({ query }, userLocationId);
    if (branchCode && branchCode !== viewerBranch.code) {
      throw httpError(403, "Forbidden: branchCode mismatch");
    }

    return viewerBranch.code;
  }

  if (requireBranchCodeForAdmin && !branchCode) {
    throw httpError(400, "branchCode is required");
  }

  return branchCode;
}

function toNullableText(value) {
  const normalized = normalizeText(value);
  return normalized || "";
}

function requireNonEmptyText(value, fieldName) {
  const normalized = normalizeText(value);
  if (!normalized) {
    throw httpError(400, `${fieldName} is required`);
  }
  return normalized;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return fallback;
}

function normalizeTransferRequestStatus(value, fallback = "PENDING") {
  const normalized = normalizeText(value).toUpperCase();
  if (!normalized) return fallback;
  if (!TRANSFER_REQUEST_STATUSES.has(normalized)) {
    throw httpError(400, `Unsupported transfer request status: ${normalized}`);
  }
  return normalized;
}

async function hasStockMovementDeleteAuditsTable(client) {
  if (hasStockMovementDeleteAuditsTableCache === true) {
    return true;
  }

  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'stock_movement_delete_audits'
      LIMIT 1
    `
  );

  if (result.rows[0]) {
    hasStockMovementDeleteAuditsTableCache = true;
    return true;
  }

  return false;
}

function composeTransferDecisionNote(baseNote, decisionLabel, reason) {
  const parts = [];
  const safeBaseNote = normalizeText(baseNote);
  if (safeBaseNote) {
    parts.push(safeBaseNote);
  }

  const safeReason = normalizeText(reason);
  if (safeReason) {
    parts.push(`${decisionLabel}: ${safeReason}`);
  } else if (decisionLabel) {
    parts.push(decisionLabel);
  }

  return parts.join("\n");
}

function toIsoDateOnly(value, fieldName) {
  return parseDateOnlyInput(value, fieldName, { allowEmpty: true });
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "").trim()
  );
}

function toExistingIsoTimestamp(value, fieldName) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw httpError(500, `Stored ${fieldName} is invalid`);
  }
  return date.toISOString();
}

function normalizeMovementWriteInput(body = {}, user = {}) {
  const movementType = normalizeText(body?.movementType).toUpperCase();
  const productId = normalizeText(body?.productId);
  const qty = toPositiveNumeric(body?.qty, "qty");
  const unitLevelIdInput = normalizeText(body?.unitLevelId || body?.unit_level_id);
  const unitLabel = normalizeText(body?.unitLabel || body?.unit);
  const lotIdInput = normalizeText(body?.lotId || body?.lot_id);
  const lotNo = normalizeText(body?.lotNo || body?.lot_no);
  const expDate = toIsoDateOnly(body?.expDate || body?.exp_date, "expDate");
  const mfgDate = toIsoDateOnly(body?.mfgDate || body?.mfg_date, "mfgDate");
  const manufacturer = normalizeText(body?.manufacturer || body?.manufacturerName);
  const note = body?.note || null;
  const createdByUserId = user?.id || body?.createdByUserId || null;
  const userRole = normalizeRole(user?.role);
  const userLocationId = toNullableText(user?.location_id);
  const fromLocationIdInput = toNullableText(body?.from_location_id ?? body?.fromLocationId);
  const toLocationIdInput = toNullableText(body?.to_location_id ?? body?.toLocationId);
  const isAdmin = userRole === "ADMIN";

  if (!MOVEMENT_TYPES.has(movementType)) {
    throw httpError(400, `Unsupported movementType: ${movementType || "-"}`);
  }
  if (!productId) throw httpError(400, "productId is required");
  if (!unitLevelIdInput && !unitLabel) {
    throw httpError(400, "unitLevelId or unitLabel is required");
  }
  if (!lotIdInput && !lotNo) throw httpError(400, "lotNo is required");
  if (!lotIdInput && !expDate) throw httpError(400, "expDate is required");

  if (!isAdmin && !userLocationId) {
    throw httpError(403, "Branch-scoped access requires location_id");
  }

  if (!isAdmin) {
    if (movementType === "RECEIVE" && toLocationIdInput && toLocationIdInput !== userLocationId) {
      throw httpError(403, "Forbidden: to_location_id mismatch");
    }
    if (
      (movementType === "TRANSFER_OUT" || movementType === "DISPENSE") &&
      fromLocationIdInput &&
      fromLocationIdInput !== userLocationId
    ) {
      throw httpError(403, "Forbidden: from_location_id mismatch");
    }
  }

  let effectiveFromLocationId = fromLocationIdInput;
  let effectiveToLocationId = toLocationIdInput;

  if (!isAdmin) {
    if (movementType === "RECEIVE") {
      effectiveToLocationId = userLocationId;
    } else if (movementType === "TRANSFER_OUT") {
      effectiveFromLocationId = userLocationId;
    } else if (movementType === "DISPENSE") {
      effectiveFromLocationId = userLocationId;
      effectiveToLocationId = "";
    }
  }

  if (movementType === "RECEIVE" && !effectiveToLocationId) {
    throw httpError(400, "to_location_id is required for RECEIVE");
  }
  if (movementType === "TRANSFER_OUT" && !effectiveFromLocationId) {
    throw httpError(400, "from_location_id is required for TRANSFER_OUT");
  }
  if (movementType === "TRANSFER_OUT" && !effectiveToLocationId) {
    throw httpError(400, "to_location_id is required for TRANSFER_OUT");
  }
  if (movementType === "DISPENSE" && !effectiveFromLocationId) {
    throw httpError(400, "from_location_id is required for DISPENSE");
  }
  if (movementType === "DISPENSE") {
    effectiveToLocationId = "";
  }

  if (
    effectiveFromLocationId &&
    effectiveToLocationId &&
    effectiveFromLocationId === effectiveToLocationId
  ) {
    throw httpError(400, "from_location_id and to_location_id must be different");
  }

  return {
    movementType,
    productId,
    qty,
    unitLevelIdInput,
    unitLabel,
    lotIdInput,
    lotNo,
    expDate,
    mfgDate,
    manufacturer,
    note,
    createdByUserId,
    effectiveFromLocationId,
    effectiveToLocationId,
  };
}

async function executeMovementWrite(client, body = {}, user = {}) {
  const input = normalizeMovementWriteInput(body, user);
  const actorUserId = await resolveActorUserId(client, input.createdByUserId);
  await ensureProductExists(client, input.productId);
  const unitLevel = await resolveRequestedUnitLevel(client, {
    productId: input.productId,
    unitLevelId: input.unitLevelIdInput,
    unitLabel: input.unitLabel,
    unitStructure: body || {},
  });
  const baseUnitLevel = await resolveProductBaseUnitLevel(client, input.productId);
  const quantityBase = convertToBase(input.qty, unitLevel);
  const lotId = await resolveLotIdForMovement(client, {
    productId: input.productId,
    movementType: input.movementType,
    explicitLotId: input.lotIdInput || null,
    lotNo: input.lotNo,
    expDate: input.expDate,
    mfgDate: input.mfgDate,
    manufacturer: input.manufacturer,
  });

  await assertUnitLevelAllowedForLot(client, {
    productId: input.productId,
    lotId,
    unitLevelId: unitLevel.id,
  });

  const fromLocation = await resolveActiveLocationById(
    client,
    input.effectiveFromLocationId,
    "from_location_id"
  );
  const toLocation = await resolveActiveLocationById(
    client,
    input.effectiveToLocationId,
    "to_location_id"
  );
  let movementCount = 0;
  let transferRequestId = null;
  let transferStatus = null;

  if (input.movementType === "RECEIVE") {
    await client.query(
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
          occurred_at,
          created_by,
          note_text
        )
        VALUES (
          'RECEIVE',
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          now(),
          $8,
          $9
        )
      `,
      [
        fromLocation?.id || null,
        toLocation?.id || null,
        input.productId,
        lotId,
        input.qty,
        convertMovementToSignedBase(input.qty, "RECEIVE", unitLevel),
        unitLevel.id,
        actorUserId,
        input.note,
      ]
    );

    await applyStockDelta(client, {
      branchId: toLocation.id,
      productId: input.productId,
      lotId,
      baseUnitLevelId: baseUnitLevel.id,
      deltaQtyBase: quantityBase,
    });

    movementCount = 1;
  } else if (input.movementType === "TRANSFER_OUT") {
    const isBranchToBranchTransfer =
      fromLocation?.locationType === "BRANCH" && toLocation?.locationType === "BRANCH";

    await applyStockDelta(client, {
      branchId: fromLocation.id,
      productId: input.productId,
      lotId,
      baseUnitLevelId: baseUnitLevel.id,
      deltaQtyBase: -quantityBase,
    });

    if (isBranchToBranchTransfer) {
      transferRequestId = randomUUID();
      transferStatus = "PENDING";

      const transferOutMovementResult = await client.query(
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
            'TRANSFER_OUT',
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9::uuid,
            now(),
            $10,
            $11
          )
          RETURNING id
        `,
        [
          fromLocation.id,
          toLocation.id,
          input.productId,
          lotId,
          input.qty,
          convertMovementToSignedBase(input.qty, "TRANSFER_OUT", unitLevel),
          unitLevel.id,
          TRANSFER_REQUEST_SOURCE_REF,
          transferRequestId,
          actorUserId,
          input.note,
        ]
      );

      await client.query(
        `
          INSERT INTO inventory_transfer_requests (
            id,
            from_location_id,
            to_location_id,
            product_id,
            lot_id,
            unit_level_id,
            base_unit_level_id,
            quantity,
            quantity_base,
            note_text,
            status,
            requested_by,
            requested_at,
            transfer_out_movement_id
          )
          VALUES (
            $1::uuid,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            'PENDING',
            $11,
            now(),
            $12
          )
        `,
        [
          transferRequestId,
          fromLocation.id,
          toLocation.id,
          input.productId,
          lotId,
          unitLevel.id,
          baseUnitLevel.id,
          input.qty,
          quantityBase,
          input.note,
          actorUserId,
          transferOutMovementResult.rows[0]?.id || null,
        ]
      );

      movementCount = 1;
    } else {
      await applyStockDelta(client, {
        branchId: toLocation.id,
        productId: input.productId,
        lotId,
        baseUnitLevelId: baseUnitLevel.id,
        deltaQtyBase: quantityBase,
      });

      await client.query(
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
            occurred_at,
            created_by,
            note_text
          )
          VALUES
            ('TRANSFER_OUT', $1, $2, $3, $4, $5, $6, $7, now(), $8, $9),
            ('TRANSFER_IN',  $1, $2, $3, $4, $5, $10, $7, now(), $8, $9)
        `,
        [
          fromLocation.id,
          toLocation.id,
          input.productId,
          lotId,
          input.qty,
          convertMovementToSignedBase(input.qty, "TRANSFER_OUT", unitLevel),
          unitLevel.id,
          actorUserId,
          input.note,
          convertMovementToSignedBase(input.qty, "TRANSFER_IN", unitLevel),
        ]
      );

      movementCount = 2;
    }
  } else {
    await applyStockDelta(client, {
      branchId: fromLocation.id,
      productId: input.productId,
      lotId,
      baseUnitLevelId: baseUnitLevel.id,
      deltaQtyBase: -quantityBase,
    });

    await client.query(
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
          occurred_at,
          created_by,
          note_text
        )
        VALUES (
          'DISPENSE',
          $1,
          NULL,
          $2,
          $3,
          $4,
          $5,
          $6,
          now(),
          $7,
          $8
        )
      `,
      [
        fromLocation.id,
        input.productId,
        lotId,
        input.qty,
        convertMovementToSignedBase(input.qty, "DISPENSE", unitLevel),
        unitLevel.id,
        actorUserId,
        input.note,
      ]
    );

    movementCount = 1;
  }

  return {
    movementType: input.movementType,
    movementCount,
    from_location_id: fromLocation?.id || null,
    to_location_id: toLocation?.id || null,
    transferRequestId,
    transferStatus,
  };
}

function normalizeMovementBatchBody(body = {}) {
  if (Array.isArray(body)) {
    return body;
  }
  if (Array.isArray(body?.movements)) {
    return body.movements;
  }
  return [];
}

async function resolveActiveLocationById(client, locationId, fieldName) {
  const normalizedId = normalizeText(locationId);
  if (!normalizedId) return null;
  if (!isUuid(normalizedId)) {
    throw httpError(400, `${fieldName} must be a valid UUID`);
  }

  const result = await client.query(
    `
      SELECT
        id,
        code,
        name,
        location_type AS "locationType",
        is_active AS "isActive"
      FROM locations
      WHERE id = $1
      LIMIT 1
    `,
    [normalizedId]
  );

  if (!result.rows[0]) {
    throw httpError(404, `${fieldName} not found`);
  }
  if (!result.rows[0].isActive) {
    throw httpError(400, `${fieldName} is inactive`);
  }

  return result.rows[0];
}

async function resolveLotIdForMovement(
  client,
  { productId, movementType, explicitLotId, lotNo, expDate, mfgDate, manufacturer }
) {
  if (explicitLotId) {
    await assertLotBelongsToProduct(client, productId, explicitLotId);
    return explicitLotId;
  }

  if (!lotNo) throw httpError(400, "lotNo is required");
  if (!expDate) throw httpError(400, "expDate is required");

  if (movementType === "RECEIVE") {
    return ensureLot(client, {
      productId,
      lotNo,
      mfgDate: mfgDate || null,
      expDate,
      manufacturer: manufacturer || null,
    });
  }

  const lotResult = await client.query(
    `
      SELECT id
      FROM product_lots
      WHERE product_id = $1
        AND lot_no = $2
        AND exp_date = $3::date
      LIMIT 1
    `,
    [productId, lotNo, expDate]
  );

  if (!lotResult.rows[0]) {
    throw httpError(
      404,
      `Lot not found for product ${productId}: ${lotNo} (exp ${expDate})`
    );
  }

  return lotResult.rows[0].id;
}

async function resolveRequestedUnitLevel(
  client,
  { productId, unitLevelId, unitLabel, unitStructure = {} }
) {
  const activePredicateWithoutAlias = productUnitLevelsActiveCompatPredicate("product_unit_levels");
  const normalizedUnitLevelId = normalizeText(unitLevelId);
  if (normalizedUnitLevelId) {
    if (!isUuid(normalizedUnitLevelId)) {
      throw httpError(400, "unit_level_id must be a valid UUID");
    }

    const result = await client.query(
      `
        SELECT id, code, display_name, unit_key, sort_order
        FROM product_unit_levels
        WHERE product_id = $1
          AND id = $2
          AND ${activePredicateWithoutAlias}
        LIMIT 1
      `,
      [productId, normalizedUnitLevelId]
    );

    if (!result.rows[0]) {
      throw httpError(404, `unit_level_id not found for product ${productId}`);
    }

    return result.rows[0];
  }

  const normalizedUnitLabel = normalizeText(unitLabel);
  if (!normalizedUnitLabel) {
    throw httpError(400, "unitLabel is required");
  }

  return ensureProductUnitLevel(client, productId, normalizedUnitLabel, unitStructure);
}

async function getTransferRequestById(client, requestId, { forUpdate = false } = {}) {
  const result = await client.query(
    `
      SELECT
        itr.id,
        itr.from_location_id AS "fromLocationId",
        itr.to_location_id AS "toLocationId",
        itr.product_id AS "productId",
        itr.lot_id AS "lotId",
        itr.unit_level_id AS "unitLevelId",
        itr.base_unit_level_id AS "baseUnitLevelId",
        itr.quantity,
        itr.quantity_base AS "quantityBase",
        itr.note_text AS "noteText",
        itr.status::text AS status,
        itr.requested_by AS "requestedBy",
        itr.requested_at AS "requestedAt",
        itr.decided_by AS "decidedBy",
        itr.decided_at AS "decidedAt",
        itr.decision_note AS "decisionNote",
        itr.transfer_out_movement_id AS "transferOutMovementId",
        itr.transfer_in_movement_id AS "transferInMovementId",
        itr.return_movement_id AS "returnMovementId",
        from_l.code AS "fromLocationCode",
        from_l.name AS "fromLocationName",
        from_l.location_type AS "fromLocationType",
        to_l.code AS "toLocationCode",
        to_l.name AS "toLocationName",
        to_l.location_type AS "toLocationType",
        p.product_code AS "productCode",
        p.trade_name AS "tradeName",
        pl.lot_no AS "lotNo",
        pl.exp_date::text AS "expDate",
        COALESCE(NULLIF(trim(pul.display_name), ''), pul.code, 'unit') AS "unitLabel"
      FROM inventory_transfer_requests itr
      JOIN locations from_l ON from_l.id = itr.from_location_id
      JOIN locations to_l ON to_l.id = itr.to_location_id
      JOIN products p ON p.id = itr.product_id
      JOIN product_lots pl ON pl.id = itr.lot_id
      JOIN product_unit_levels pul ON pul.id = itr.unit_level_id
      WHERE itr.id = $1
      ${forUpdate ? "FOR UPDATE" : ""}
      LIMIT 1
    `,
    [requestId]
  );

  return result.rows[0] || null;
}

export async function receiveInventory(req, res) {
  const toBranchCode = String(req.body?.toBranchCode || "").trim();
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const note = req.body?.note || null;
  const createdByUserId = req.user?.id || req.body?.createdByUserId || null;

  if (!toBranchCode) throw httpError(400, "toBranchCode is required");
  if (!items.length) throw httpError(400, "items must contain at least one item");

  const result = await withTransaction(async (client) => {
    const branch = await resolveBranchByCode(client, toBranchCode);
    const actorUserId = await resolveActorUserId(client, createdByUserId);
    let movementCount = 0;

    for (const item of items) {
      const productId = item?.productId;
      const qty = toPositiveNumeric(item?.qty, "qty");
      const unitLabel = normalizeText(item?.unitLabel || item?.unit);
      const unitLevelId = normalizeText(item?.unitLevelId || item?.unit_level_id);
      if (!unitLevelId && !unitLabel) {
        throw httpError(400, "unitLevelId or unitLabel is required");
      }

      await ensureProductExists(client, productId);
      const unitLevel = await resolveRequestedUnitLevel(client, {
        productId,
        unitLevelId,
        unitLabel,
        unitStructure: item || {},
      });
      const baseUnitLevel = await resolveProductBaseUnitLevel(client, productId);
      const quantityBase = convertToBase(qty, unitLevel);

      const lotId =
        item?.lotId ||
        (await ensureLot(client, {
          productId,
          lotNo: item?.lotNo,
          mfgDate: item?.mfgDate || null,
          expDate: item?.expDate,
          manufacturer: item?.manufacturer || null,
        }));

      if (item?.lotId) {
        await assertLotBelongsToProduct(client, productId, item.lotId);
      }
      await assertUnitLevelAllowedForLot(client, {
        productId,
        lotId,
        unitLevelId: unitLevel.id,
      });

      await client.query(
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
            occurred_at,
            created_by,
            note_text
          )
          VALUES (
            'RECEIVE',
            NULL,
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            now(),
            $7,
            $8
          )
        `,
        [
          branch.id,
          productId,
          lotId || null,
          qty,
          quantityBase,
          unitLevel.id,
          actorUserId,
          note,
        ]
      );

      await applyStockDelta(client, {
        branchId: branch.id,
        productId,
        lotId: lotId || null,
        baseUnitLevelId: baseUnitLevel.id,
        deltaQtyBase: quantityBase,
      });

      movementCount += 1;
    }

    return {
      branchCode: branch.code,
      movementCount,
    };
  });

  return res.status(201).json({
    ok: true,
    ...result,
  });
}

export async function transferInventory(req, res) {
  const fromBranchCode = String(req.body?.fromBranchCode || "").trim();
  const toBranchCode = String(req.body?.toBranchCode || "").trim();
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const note = req.body?.note || null;
  const createdByUserId = req.user?.id || req.body?.createdByUserId || null;

  if (!fromBranchCode) throw httpError(400, "fromBranchCode is required");
  if (!toBranchCode) throw httpError(400, "toBranchCode is required");
  if (fromBranchCode === toBranchCode) {
    throw httpError(400, "fromBranchCode and toBranchCode must be different");
  }
  if (!items.length) throw httpError(400, "items must contain at least one item");

  const result = await withTransaction(async (client) => {
    const fromBranch = await resolveBranchByCode(client, fromBranchCode);
    const toBranch = await resolveBranchByCode(client, toBranchCode);
    const actorUserId = await resolveActorUserId(client, createdByUserId);
    let movementCount = 0;

    for (const item of items) {
      const productId = item?.productId;
      const qty = toPositiveNumeric(item?.qty, "qty");
      const unitLabel = normalizeText(item?.unitLabel || item?.unit);
      const unitLevelId = normalizeText(item?.unitLevelId || item?.unit_level_id);
      if (!unitLevelId && !unitLabel) {
        throw httpError(400, "unitLevelId or unitLabel is required");
      }

      await ensureProductExists(client, productId);
      const unitLevel = await resolveRequestedUnitLevel(client, {
        productId,
        unitLevelId,
        unitLabel,
        unitStructure: item || {},
      });
      const baseUnitLevel = await resolveProductBaseUnitLevel(client, productId);
      const quantityBase = convertToBase(qty, unitLevel);
      const lotId = item?.lotId || null;
      if (lotId) {
        await assertLotBelongsToProduct(client, productId, lotId);
      }
      await assertUnitLevelAllowedForLot(client, {
        productId,
        lotId,
        unitLevelId: unitLevel.id,
      });

      await applyStockDelta(client, {
        branchId: fromBranch.id,
        productId,
        lotId,
        baseUnitLevelId: baseUnitLevel.id,
        deltaQtyBase: -quantityBase,
      });
      await applyStockDelta(client, {
        branchId: toBranch.id,
        productId,
        lotId,
        baseUnitLevelId: baseUnitLevel.id,
        deltaQtyBase: quantityBase,
      });

      await client.query(
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
            occurred_at,
            created_by,
            note_text
          )
          VALUES
            ('TRANSFER_OUT', $1, $2, $3, $4, $5, $6, $7, now(), $8, $9),
            ('TRANSFER_IN',  $1, $2, $3, $4, $5, $10, $7, now(), $8, $9)
        `,
        [
          fromBranch.id,
          toBranch.id,
          productId,
          lotId,
          qty,
          -quantityBase,
          unitLevel.id,
          actorUserId,
          note,
          quantityBase,
        ]
      );

      movementCount += 2;
    }

    return {
      fromBranchCode: fromBranch.code,
      toBranchCode: toBranch.code,
      movementCount,
    };
  });

  return res.status(201).json({
    ok: true,
    ...result,
  });
}

export async function createMovement(req, res) {
  const result = await withTransaction((client) => executeMovementWrite(client, req.body, req.user));

  return res.status(201).json({
    ok: true,
    ...result,
  });
}

export async function createMovementBatch(req, res) {
  const movements = normalizeMovementBatchBody(req.body);

  if (!movements.length) {
    throw httpError(400, "movements must contain at least one item");
  }

  const result = await withTransaction(async (client) => {
    const items = [];
    let movementCount = 0;

    for (let index = 0; index < movements.length; index += 1) {
      const movement = movements[index];
      if (!movement || typeof movement !== "object" || Array.isArray(movement)) {
        throw httpError(400, `Movement row ${index + 1} must be an object`, {
          rowIndex: index,
          rowNumber: index + 1,
        });
      }

      try {
        const itemResult = await executeMovementWrite(client, movement, req.user);
        items.push({
          rowIndex: index,
          rowNumber: index + 1,
          ...itemResult,
        });
        movementCount += Number(itemResult?.movementCount || 0);
      } catch (error) {
        throw httpError(
          Number(error?.status || 400),
          `Movement row ${index + 1} failed: ${error?.message || "Invalid movement payload"}`,
          {
            rowIndex: index,
            rowNumber: index + 1,
            movementType: normalizeText(movement?.movementType).toUpperCase() || null,
            reason: error?.message || "Invalid movement payload",
            cause: error?.details ?? null,
          }
        );
      }
    }

    return {
      itemCount: items.length,
      movementCount,
      items,
    };
  });

  return res.status(201).json({
    ok: true,
    ...result,
  });
}

export async function listTransferRequests(req, res) {
  const requestedLocationId =
    req.query.location_id || req.query.locationId
      ? normalizeText(req.query.location_id || req.query.locationId)
      : "";
  const status = normalizeTransferRequestStatus(req.query.status, "PENDING");
  const requestedLimit = Number(req.query.limit);
  const safeLimit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.floor(requestedLimit), 1), 100)
    : 20;
  const userRole = normalizeRole(req.user?.role);
  const userLocationId = normalizeText(req.user?.location_id);
  const effectiveToLocationId =
    userRole === "ADMIN" ? requestedLocationId : userLocationId || requestedLocationId;

  if (userRole !== "ADMIN" && requestedLocationId && requestedLocationId !== userLocationId) {
    throw httpError(403, "Forbidden: location filter mismatch");
  }
  if (userRole !== "ADMIN" && !effectiveToLocationId) {
    throw httpError(403, "Branch-scoped access requires location_id");
  }

  const params = [];
  const where = ["1=1"];

  params.push(status);
  where.push(`itr.status = $${params.length}::transfer_request_status`);

  if (effectiveToLocationId) {
    params.push(effectiveToLocationId);
    where.push(`itr.to_location_id = $${params.length}::uuid`);
  }

  params.push(safeLimit);

  const result = await query(
    `
      SELECT
        itr.id,
        itr.status::text AS status,
        itr.quantity,
        itr.quantity_base AS "quantityBase",
        itr.note_text AS note,
        itr.requested_at AS "requestedAt",
        itr.decided_at AS "decidedAt",
        itr.decision_note AS "decisionNote",
        itr.from_location_id AS "fromLocationId",
        itr.to_location_id AS "toLocationId",
        from_l.code AS "fromBranchCode",
        from_l.name AS "fromBranchName",
        to_l.code AS "toBranchCode",
        to_l.name AS "toBranchName",
        p.id AS "productId",
        p.product_code AS "productCode",
        p.trade_name AS "tradeName",
        pl.id AS "lotId",
        pl.lot_no AS "lotNo",
        pl.exp_date::text AS "expDate",
        COALESCE(NULLIF(trim(pul.display_name), ''), pul.code, 'unit') AS "unitLabel",
        barcode_pick.barcode AS barcode,
        req_user.username AS "requestedByUsername",
        COALESCE(NULLIF(trim(req_user.full_name), ''), req_user.username, 'unknown') AS "requestedByName",
        dec_user.username AS "decidedByUsername",
        COALESCE(NULLIF(trim(dec_user.full_name), ''), dec_user.username, '') AS "decidedByName"
      FROM inventory_transfer_requests itr
      JOIN locations from_l ON from_l.id = itr.from_location_id
      JOIN locations to_l ON to_l.id = itr.to_location_id
      JOIN products p ON p.id = itr.product_id
      JOIN product_lots pl ON pl.id = itr.lot_id
      JOIN product_unit_levels pul ON pul.id = itr.unit_level_id
      LEFT JOIN users req_user ON req_user.id = itr.requested_by
      LEFT JOIN users dec_user ON dec_user.id = itr.decided_by
      LEFT JOIN LATERAL (
        SELECT pu.barcode
        FROM product_unit_levels pu
        WHERE pu.product_id = itr.product_id
          AND pu.barcode IS NOT NULL
        ORDER BY
          (pu.id = itr.unit_level_id) DESC,
          pu.is_sellable DESC,
          pu.is_base DESC,
          pu.sort_order ASC,
          pu.created_at ASC
        LIMIT 1
      ) barcode_pick ON true
      WHERE ${where.join(" AND ")}
      ORDER BY itr.requested_at DESC
      LIMIT $${params.length}
    `,
    params
  );

  return res.json(result.rows);
}

export async function acceptTransferRequest(req, res) {
  const requestId = normalizeText(req.params?.id);
  const decisionNote = normalizeText(
    req.body?.note ?? req.body?.decisionNote ?? req.body?.decision_note
  );
  const userRole = normalizeRole(req.user?.role);
  const userLocationId = normalizeText(req.user?.location_id);
  const decidedByUserId = req.user?.id || req.body?.decidedByUserId || null;

  if (!isUuid(requestId)) {
    throw httpError(400, "transfer request id must be a valid UUID");
  }

  const result = await withTransaction(async (client) => {
    const actorUserId = await resolveActorUserId(client, decidedByUserId);
    const transferRequest = await getTransferRequestById(client, requestId, { forUpdate: true });

    if (!transferRequest) {
      throw httpError(404, "Transfer request not found");
    }
    if (userRole !== "ADMIN") {
      if (!userLocationId) {
        throw httpError(403, "Branch-scoped access requires location_id");
      }
      if (transferRequest.toLocationId !== userLocationId) {
        throw httpError(403, "Forbidden: transfer request does not belong to this branch");
      }
    }
    if (transferRequest.status !== "PENDING") {
      throw httpError(409, `Transfer request is already ${transferRequest.status.toLowerCase()}`);
    }

    await applyStockDelta(client, {
      branchId: transferRequest.toLocationId,
      productId: transferRequest.productId,
      lotId: transferRequest.lotId,
      baseUnitLevelId: transferRequest.baseUnitLevelId,
      deltaQtyBase: Number(transferRequest.quantityBase),
    });

    const transferInResult = await client.query(
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
          'TRANSFER_IN',
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9::uuid,
          now(),
          $10,
          $11
        )
        RETURNING id
      `,
      [
        transferRequest.fromLocationId,
        transferRequest.toLocationId,
        transferRequest.productId,
        transferRequest.lotId,
        transferRequest.quantity,
        Number(transferRequest.quantityBase),
        transferRequest.unitLevelId,
        TRANSFER_REQUEST_SOURCE_REF,
        transferRequest.id,
        actorUserId,
        transferRequest.noteText || null,
      ]
    );

    await client.query(
      `
        UPDATE inventory_transfer_requests
        SET status = 'ACCEPTED',
            decided_by = $2,
            decided_at = now(),
            decision_note = $3,
            transfer_in_movement_id = $4
        WHERE id = $1::uuid
      `,
      [transferRequest.id, actorUserId, decisionNote || null, transferInResult.rows[0]?.id || null]
    );

    return {
      id: transferRequest.id,
      status: "ACCEPTED",
      transferInMovementId: transferInResult.rows[0]?.id || null,
    };
  });

  return res.json({
    ok: true,
    ...result,
  });
}

export async function rejectTransferRequest(req, res) {
  const requestId = normalizeText(req.params?.id);
  const reason = requireNonEmptyText(
    req.body?.reason ?? req.body?.decisionNote ?? req.body?.decision_note,
    "reason"
  );
  const userRole = normalizeRole(req.user?.role);
  const userLocationId = normalizeText(req.user?.location_id);
  const decidedByUserId = req.user?.id || req.body?.decidedByUserId || null;

  if (!isUuid(requestId)) {
    throw httpError(400, "transfer request id must be a valid UUID");
  }

  const result = await withTransaction(async (client) => {
    const actorUserId = await resolveActorUserId(client, decidedByUserId);
    const transferRequest = await getTransferRequestById(client, requestId, { forUpdate: true });

    if (!transferRequest) {
      throw httpError(404, "Transfer request not found");
    }
    if (userRole !== "ADMIN") {
      if (!userLocationId) {
        throw httpError(403, "Branch-scoped access requires location_id");
      }
      if (transferRequest.toLocationId !== userLocationId) {
        throw httpError(403, "Forbidden: transfer request does not belong to this branch");
      }
    }
    if (transferRequest.status !== "PENDING") {
      throw httpError(409, `Transfer request is already ${transferRequest.status.toLowerCase()}`);
    }

    await applyStockDelta(client, {
      branchId: transferRequest.fromLocationId,
      productId: transferRequest.productId,
      lotId: transferRequest.lotId,
      baseUnitLevelId: transferRequest.baseUnitLevelId,
      deltaQtyBase: Number(transferRequest.quantityBase),
    });

    const returnMovementResult = await client.query(
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
          'TRANSFER_IN',
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9::uuid,
          now(),
          $10,
          $11
        )
        RETURNING id
      `,
      [
        transferRequest.toLocationId,
        transferRequest.fromLocationId,
        transferRequest.productId,
        transferRequest.lotId,
        transferRequest.quantity,
        Number(transferRequest.quantityBase),
        transferRequest.unitLevelId,
        TRANSFER_REQUEST_SOURCE_REF,
        transferRequest.id,
        actorUserId,
        composeTransferDecisionNote(
          transferRequest.noteText,
          `Transfer rejected by ${transferRequest.toLocationCode || transferRequest.toLocationId}`,
          reason
        ),
      ]
    );

    await client.query(
      `
        UPDATE inventory_transfer_requests
        SET status = 'REJECTED',
            decided_by = $2,
            decided_at = now(),
            decision_note = $3,
            return_movement_id = $4
        WHERE id = $1::uuid
      `,
      [transferRequest.id, actorUserId, reason, returnMovementResult.rows[0]?.id || null]
    );

    return {
      id: transferRequest.id,
      status: "REJECTED",
      returnMovementId: returnMovementResult.rows[0]?.id || null,
    };
  });

  return res.json({
    ok: true,
    ...result,
  });
}

export async function listLocations(req, res) {
  const includeInactive = parseBoolean(req.query.includeInactive, false);
  const locationType = normalizeText(req.query.locationType || req.query.type).toUpperCase();
  if (locationType && !LOCATION_TYPES.has(locationType)) {
    throw httpError(400, `Unsupported locationType: ${locationType}`);
  }

  const params = [];
  const where = [];
  if (!includeInactive) {
    where.push("is_active = true");
  }
  if (locationType) {
    params.push(locationType);
    where.push(`location_type = $${params.length}::location_type`);
  }

  const result = await query(
    `
      SELECT
        id,
        code,
        name,
        location_type AS type,
        is_active AS "is_active"
      FROM locations
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY location_type ASC, code ASC, name ASC
    `,
    params
  );

  return res.json(result.rows);
}

export async function getStockOnHand(req, res) {
  const branchCode = String(req.query.branchCode || "").trim();
  const productId = String(req.query.productId || "").trim();
  const effectiveBranchCode = await resolveAccessibleBranchCodeForStockRead({
    requestedBranchCode: branchCode,
    user: req.user,
  });

  const params = [];
  const where = ["l.location_type = 'BRANCH'"];
  if (effectiveBranchCode) {
    params.push(effectiveBranchCode);
    where.push(`l.code = $${params.length}`);
  }
  if (productId) {
    params.push(productId);
    where.push(`soh.product_id = $${params.length}::uuid`);
  }

  const result = await query(
    `
      SELECT
        l.code AS "branchCode",
        l.name AS "branchName",
        p.id AS "productId",
        p.product_code AS "productCode",
        p.trade_name AS "tradeName",
        pl.id AS "lotId",
        pl.lot_no AS "lotNo",
        pl.exp_date AS "expDate",
        soh.quantity_on_hand AS "quantityBase",
        soh.quantity_on_hand AS "quantity",
        COALESCE(ut.code, pul.code, 'BASE') AS "unitCode",
        COALESCE(NULLIF(trim(pul.display_name), ''), NULLIF(ut.symbol, ''), ut.code, pul.code, 'base') AS "unitLabel",
        COALESCE(NULLIF(ut.symbol, ''), ut.code, pul.code, 'base') AS "baseUnitLabel"
      FROM stock_on_hand soh
      JOIN locations l ON l.id = soh.branch_id
      JOIN products p ON p.id = soh.product_id
      LEFT JOIN product_lots pl ON pl.id = soh.lot_id
      LEFT JOIN product_unit_levels pul ON pul.id = soh.base_unit_level_id
      LEFT JOIN unit_types ut ON ut.id = pul.unit_type_id
      WHERE ${where.join(" AND ")}
        AND soh.quantity_on_hand > 0
      ORDER BY l.code, p.trade_name, pl.exp_date NULLS LAST, pl.lot_no
    `,
    params
  );

  return res.json(result.rows);
}

export async function getDeliverSearchProducts(req, res) {
  const branchCode = normalizeText(req.query.branchCode);
  const effectiveBranchCode = await resolveAccessibleBranchCodeForStockRead({
    requestedBranchCode: branchCode,
    user: req.user,
    requireBranchCodeForAdmin: true,
  });
  const defaultUnitActivePredicate = productUnitLevelsActiveCompatPredicate("default_pul");
  const baseUnitActivePredicate = productUnitLevelsActiveCompatPredicate("base_pul");

  const result = await query(
    `
      SELECT
        p.id AS id,
        p.id AS "productId",
        p.product_code AS "productCode",
        p.trade_name AS "tradeName",
        COALESCE(ingredient_names.generic_name, p.generic_name, '') AS "genericName",
        COALESCE(ingredient_names.active_ingredient_text, '') AS "activeIngredientText",
        default_pul.barcode AS barcode,
        COALESCE(default_price.price, 0) AS price,
        COALESCE(
          NULLIF(TRIM(default_pul.display_name), ''),
          NULLIF(default_ut.symbol, ''),
          default_ut.code,
          default_pul.code,
          base_unit.base_unit_label,
          'base'
        ) AS "unitLabel",
        base_unit.base_unit_label AS "baseUnitLabel",
        COALESCE(SUM(soh.quantity_on_hand), 0) AS "quantityBase",
        COALESCE(report_groups.report_group_codes, ARRAY[]::text[]) AS "reportGroupCodes"
      FROM stock_on_hand soh
      JOIN locations l ON l.id = soh.branch_id
      JOIN products p ON p.id = soh.product_id
      LEFT JOIN LATERAL (
        SELECT
          string_agg(DISTINCT ai.name_en, ' ' ORDER BY ai.name_en) AS generic_name,
          string_agg(
            DISTINCT CONCAT_WS(' ', ai.code, ai.name_en, ai.name_th),
            ' '
            ORDER BY CONCAT_WS(' ', ai.code, ai.name_en, ai.name_th)
          ) AS active_ingredient_text
        FROM product_ingredients pi
        JOIN active_ingredients ai ON ai.id = pi.active_ingredient_id
        WHERE pi.product_id = p.id
      ) ingredient_names ON true
      LEFT JOIN LATERAL (
        SELECT array_agg(rg.code ORDER BY rg.code) AS report_group_codes
        FROM product_report_groups prg
        JOIN report_groups rg ON rg.id = prg.report_group_id
        WHERE prg.product_id = p.id
          AND prg.effective_from <= CURRENT_DATE
          AND (prg.effective_to IS NULL OR prg.effective_to > CURRENT_DATE)
      ) report_groups ON true
      LEFT JOIN LATERAL (
        SELECT
          default_pul.id,
          default_pul.code,
          default_pul.barcode,
          default_pul.display_name,
          default_pul.unit_type_id
        FROM product_unit_levels default_pul
        WHERE default_pul.product_id = p.id
          AND ${defaultUnitActivePredicate}
        ORDER BY
          default_pul.is_sellable DESC,
          default_pul.is_base DESC,
          default_pul.sort_order ASC,
          default_pul.created_at ASC
        LIMIT 1
      ) default_pul ON true
      LEFT JOIN unit_types default_ut ON default_ut.id = default_pul.unit_type_id
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(
            NULLIF(TRIM(base_pul.display_name), ''),
            NULLIF(base_ut.symbol, ''),
            base_ut.code,
            base_pul.code,
            'base'
          ) AS base_unit_label
        FROM product_unit_levels base_pul
        LEFT JOIN unit_types base_ut ON base_ut.id = base_pul.unit_type_id
        WHERE base_pul.product_id = p.id
          AND ${baseUnitActivePredicate}
        ORDER BY
          base_pul.is_base DESC,
          base_pul.sort_order ASC,
          base_pul.created_at ASC
        LIMIT 1
      ) base_unit ON true
      LEFT JOIN LATERAL (
        SELECT pp.price
        FROM product_prices pp
        LEFT JOIN price_tiers pt ON pt.id = pp.price_tier_id
        WHERE pp.product_id = p.id
          AND pp.unit_level_id = default_pul.id
          AND (pp.effective_to IS NULL OR pp.effective_to >= CURRENT_DATE)
        ORDER BY
          COALESCE(pt.is_default, false) DESC,
          pp.effective_from DESC
        LIMIT 1
      ) default_price ON true
      WHERE l.location_type = 'BRANCH'
        AND l.code = $1
        AND p.is_active = true
        AND soh.quantity_on_hand > 0
        AND (
          EXISTS (
            SELECT 1
            FROM product_report_groups prg
            JOIN report_groups rg ON rg.id = prg.report_group_id
            WHERE prg.product_id = p.id
              AND prg.effective_from <= CURRENT_DATE
              AND (prg.effective_to IS NULL OR prg.effective_to > CURRENT_DATE)
              AND rg.code = 'KY10'
          )
          OR (
            EXISTS (
              SELECT 1
              FROM product_report_groups prg
              JOIN report_groups rg ON rg.id = prg.report_group_id
              WHERE prg.product_id = p.id
                AND prg.effective_from <= CURRENT_DATE
                AND (prg.effective_to IS NULL OR prg.effective_to > CURRENT_DATE)
                AND rg.code = 'KY11'
            )
            AND EXISTS (
              SELECT 1
              FROM product_ingredients pi
              JOIN active_ingredients ai ON ai.id = pi.active_ingredient_id
              WHERE pi.product_id = p.id
                AND (
                  ai.code ILIKE '%TRAMADOL%'
                  OR ai.name_en ILIKE '%TRAMADOL%'
                  OR COALESCE(ai.name_th, '') ILIKE '%TRAMADOL%'
                )
            )
          )
        )
      GROUP BY
        p.id,
        p.product_code,
        p.trade_name,
        ingredient_names.generic_name,
        ingredient_names.active_ingredient_text,
        default_pul.barcode,
        default_pul.display_name,
        default_pul.code,
        default_ut.symbol,
        default_ut.code,
        base_unit.base_unit_label,
        default_price.price,
        report_groups.report_group_codes
      ORDER BY p.trade_name ASC, p.product_code ASC
    `,
    [effectiveBranchCode]
  );

  return res.json(
    result.rows.map((row) => ({
      id: row.id,
      productId: row.productId,
      productCode: row.productCode,
      tradeName: row.tradeName,
      genericName: row.genericName || "",
      activeIngredientText: row.activeIngredientText || "",
      barcode: row.barcode || "",
      price: Number(row.price || 0),
      unitLabel: row.unitLabel || row.baseUnitLabel || "",
      baseUnitLabel: row.baseUnitLabel || "",
      quantityBase: Number(row.quantityBase || 0),
      reportGroupCodes: Array.isArray(row.reportGroupCodes) ? row.reportGroupCodes : [],
    }))
  );
}

export async function updateMovementOccurredAtCorrection(req, res) {
  const movementId = normalizeText(req.params?.id);
  const correctedOccurredAtInput = normalizeText(
    req.body?.correctedOccurredAt ?? req.body?.corrected_occurred_at ?? req.body?.occurredAt
  );
  const reason = requireNonEmptyText(
    req.body?.reason ?? req.body?.reasonText ?? req.body?.reason_text,
    "reason"
  );
  const editedByUserId = req.user?.id || req.body?.editedByUserId || null;

  if (!isUuid(movementId)) {
    throw httpError(400, "movement id must be a valid UUID");
  }
  if (!correctedOccurredAtInput) {
    throw httpError(400, "correctedOccurredAt is required");
  }

  const requestedOccurredAt = toIsoTimestamp(correctedOccurredAtInput);

  const result = await withTransaction(async (client) => {
    const actorUserId = await resolveActorUserId(client, editedByUserId);
    const movementResult = await client.query(
      `
        SELECT
          sm.id,
          sm.movement_type AS "movementType",
          sm.occurred_at AS "originalOccurredAt",
          sm.corrected_occurred_at AS "correctedOccurredAt"
        FROM stock_movements sm
        WHERE sm.id = $1
        LIMIT 1
      `,
      [movementId]
    );

    const movement = movementResult.rows[0];
    if (!movement) {
      throw httpError(404, "Movement not found");
    }
    if (movement.movementType !== "RECEIVE") {
      throw httpError(400, "Only RECEIVE movements support occurred_at correction");
    }

    const originalOccurredAtIso = toExistingIsoTimestamp(
      movement.originalOccurredAt,
      "stock_movements.occurred_at"
    );
    const previousCorrectedOccurredAtIso = movement.correctedOccurredAt
      ? toExistingIsoTimestamp(
          movement.correctedOccurredAt,
          "stock_movements.corrected_occurred_at"
        )
      : null;
    const previousEffectiveOccurredAtIso =
      previousCorrectedOccurredAtIso || originalOccurredAtIso;
    const nextCorrectedOccurredAtIso =
      requestedOccurredAt === originalOccurredAtIso ? null : requestedOccurredAt;
    const nextEffectiveOccurredAtIso =
      nextCorrectedOccurredAtIso || originalOccurredAtIso;

    if (nextEffectiveOccurredAtIso === previousEffectiveOccurredAtIso) {
      throw httpError(400, "No occurredAt change detected");
    }

    await client.query(
      `
        UPDATE stock_movements
        SET corrected_occurred_at = $2::timestamptz
        WHERE id = $1
      `,
      [movementId, nextCorrectedOccurredAtIso]
    );

    await client.query(
      `
        INSERT INTO stock_movement_occurred_at_audits (
          movement_id,
          original_occurred_at,
          previous_corrected_occurred_at,
          previous_effective_occurred_at,
          new_corrected_occurred_at,
          new_effective_occurred_at,
          reason_text,
          edited_by
        )
        VALUES (
          $1,
          $2::timestamptz,
          $3::timestamptz,
          $4::timestamptz,
          $5::timestamptz,
          $6::timestamptz,
          $7,
          $8
        )
      `,
      [
        movementId,
        originalOccurredAtIso,
        previousCorrectedOccurredAtIso,
        previousEffectiveOccurredAtIso,
        nextCorrectedOccurredAtIso,
        nextEffectiveOccurredAtIso,
        reason,
        actorUserId,
      ]
    );

    return {
      id: movementId,
      movementType: movement.movementType,
      originalOccurredAt: originalOccurredAtIso,
      correctedOccurredAt: nextCorrectedOccurredAtIso,
      occurredAt: nextEffectiveOccurredAtIso,
      correctionCleared: nextCorrectedOccurredAtIso === null,
    };
  });

  return res.json({
    ok: true,
    ...result,
  });
}

export async function deleteMovement(req, res) {
  const movementId = normalizeText(req.params?.id);
  const reason = requireNonEmptyText(
    req.body?.reason ?? req.body?.reasonText ?? req.body?.reason_text,
    "reason"
  );
  const deletedByUserId = req.user?.id || req.body?.deletedByUserId || null;

  if (!isUuid(movementId)) {
    throw httpError(400, "movement id must be a valid UUID");
  }

  const result = await withTransaction(async (client) => {
    if (!(await hasStockMovementDeleteAuditsTable(client))) {
      throw httpError(503, "stock movement delete audit table is not deployed yet; run migration 0023 first");
    }

    const actorUserId = await resolveActorUserId(client, deletedByUserId);
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
          sm.dispense_line_id AS "dispenseLineId",
          sm.source_ref_type AS "sourceRefType",
          sm.source_ref_id AS "sourceRefId",
          sm.occurred_at AS "occurredAt",
          sm.created_by AS "createdBy",
          sm.note_text AS "noteText",
          sm.created_at AS "createdAt",
          row_to_json(sm)::jsonb AS "movementSnapshot"
        FROM stock_movements sm
        WHERE sm.id = $1::uuid
        FOR UPDATE
        LIMIT 1
      `,
      [movementId]
    );

    const movement = movementResult.rows[0];
    if (!movement) {
      throw httpError(404, "Movement not found");
    }

    if (movement.movementType !== "RECEIVE") {
      throw httpError(400, "Only manual RECEIVE movements can be deleted from this screen");
    }
    if (normalizeText(movement.sourceRefType)) {
      throw httpError(409, "This movement is linked to another workflow and cannot be deleted directly");
    }
    if (movement.dispenseLineId) {
      throw httpError(409, "This movement is linked to a dispense line and cannot be deleted directly");
    }
    if (!movement.toLocationId) {
      throw httpError(400, "Stored RECEIVE movement is missing to_location_id");
    }

    const transferReferenceResult = await client.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM inventory_transfer_requests itr
          WHERE itr.transfer_out_movement_id = $1::uuid
             OR itr.transfer_in_movement_id = $1::uuid
             OR itr.return_movement_id = $1::uuid
        ) AS "hasTransferReference"
      `,
      [movementId]
    );

    let hasIncidentResolutionReference = false;
    const incidentResolutionTableResult = await client.query(
      `SELECT to_regclass('public.incident_report_resolution_actions') AS table_name`
    );
    if (incidentResolutionTableResult.rows[0]?.table_name) {
      const incidentResolutionReferenceResult = await client.query(
        `
          SELECT EXISTS (
            SELECT 1
            FROM incident_report_resolution_actions irra
            WHERE irra.applied_stock_movement_id = $1::uuid
          ) AS "hasIncidentResolutionReference"
        `,
        [movementId]
      );
      hasIncidentResolutionReference = Boolean(
        incidentResolutionReferenceResult.rows[0]?.hasIncidentResolutionReference
      );
    }

    if (transferReferenceResult.rows[0]?.hasTransferReference || hasIncidentResolutionReference) {
      throw httpError(409, "This movement is referenced by another record and cannot be deleted directly");
    }

    const quantityBase = Number(movement.quantityBase);
    if (!Number.isFinite(quantityBase) || quantityBase <= 0) {
      throw httpError(500, "Stored RECEIVE movement has invalid quantity_base");
    }

    const baseUnitLevel = await resolveProductBaseUnitLevel(client, movement.productId);
    const reversedDeltaQtyBase = -quantityBase;

    await applyStockDelta(client, {
      branchId: movement.toLocationId,
      productId: movement.productId,
      lotId: movement.lotId || null,
      baseUnitLevelId: baseUnitLevel.id,
      deltaQtyBase: reversedDeltaQtyBase,
    });

    const auditResult = await client.query(
      `
        INSERT INTO stock_movement_delete_audits (
          deleted_movement_id,
          movement_type,
          product_id,
          lot_id,
          from_location_id,
          to_location_id,
          quantity,
          quantity_base,
          unit_level_id,
          occurred_at,
          source_ref_type,
          source_ref_id,
          note_text,
          movement_snapshot,
          reason_text,
          reversed_branch_id,
          reversed_delta_qty_base,
          deleted_by,
          deleted_at
        )
        VALUES (
          $1::uuid,
          $2::movement_type,
          $3::uuid,
          $4::uuid,
          $5::uuid,
          $6::uuid,
          $7,
          $8,
          $9::uuid,
          $10::timestamptz,
          $11,
          $12::uuid,
          $13,
          $14::jsonb,
          $15,
          $16::uuid,
          $17,
          $18::uuid,
          now()
        )
        RETURNING id, deleted_at AS "deletedAt"
      `,
      [
        movement.id,
        movement.movementType,
        movement.productId,
        movement.lotId || null,
        movement.fromLocationId || null,
        movement.toLocationId,
        movement.quantity,
        movement.quantityBase,
        movement.unitLevelId,
        movement.occurredAt,
        movement.sourceRefType || null,
        movement.sourceRefId || null,
        movement.noteText || null,
        movement.movementSnapshot,
        reason,
        movement.toLocationId,
        reversedDeltaQtyBase,
        actorUserId,
      ]
    );

    await client.query(
      `
        DELETE FROM stock_movements
        WHERE id = $1::uuid
      `,
      [movementId]
    );

    return {
      id: movementId,
      deletedAuditId: auditResult.rows[0]?.id || null,
      deletedAt: auditResult.rows[0]?.deletedAt || null,
      reversedBranchId: movement.toLocationId,
      reversedDeltaQtyBase,
    };
  });

  return res.json({
    ok: true,
    ...result,
  });
}

export async function getMovements(req, res) {
  const sellableUnitActivePredicate = productUnitLevelsActiveCompatPredicate("puls");
  const baseUnitActivePredicate = productUnitLevelsActiveCompatPredicate("pulb");
  const productId = req.query.productId ? String(req.query.productId).trim() : "";
  const movementType = req.query.movementType ? String(req.query.movementType).trim().toUpperCase() : "";
  const branchCode = req.query.branchCode ? String(req.query.branchCode).trim() : "";
  const requestedLocationId =
    req.query.location_id || req.query.locationId
      ? String(req.query.location_id || req.query.locationId).trim()
      : "";
  const fromInput = req.query.from ?? req.query.fromDate;
  const toInput = req.query.to ?? req.query.toDate;
  const from = fromInput ? new Date(String(fromInput)) : null;
  const to = toInput ? new Date(String(toInput)) : null;
  const requestedLimit = Number(req.query.limit);
  const safeLimit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.floor(requestedLimit), 1), 1000)
    : 1000;
  const userRole = String(req.user?.role || "").trim().toUpperCase();
  const userLocationId = req.user?.location_id ? String(req.user.location_id).trim() : "";
  const effectiveLocationId =
    userRole === "ADMIN"
      ? requestedLocationId
      : userLocationId || requestedLocationId;

  if (userRole !== "ADMIN" && requestedLocationId && requestedLocationId !== userLocationId) {
    throw httpError(403, "Forbidden: location filter mismatch");
  }

  if (from && Number.isNaN(from.getTime())) throw httpError(400, "Invalid from datetime");
  if (to && Number.isNaN(to.getTime())) throw httpError(400, "Invalid to datetime");
  if (movementType && !MOVEMENT_REPORT_TYPES.has(movementType)) {
    throw httpError(400, `Unsupported movementType filter: ${movementType}`);
  }

  const params = [];
  const where = ["1=1"];
  const effectiveOccurredAtSql = "COALESCE(sm.corrected_occurred_at, sm.occurred_at)";
  const branchPerspectiveCondition = (columnSql, parameterSql) => `
    (
      (sm.movement_type IN ('RECEIVE', 'TRANSFER_IN') AND to_l.${columnSql} = ${parameterSql})
      OR (sm.movement_type IN ('TRANSFER_OUT', 'DISPENSE') AND from_l.${columnSql} = ${parameterSql})
      OR (
        sm.movement_type = 'ADJUST'
        AND (
          from_l.${columnSql} = ${parameterSql}
          OR to_l.${columnSql} = ${parameterSql}
        )
      )
    )
  `;

  if (productId) {
    params.push(productId);
    where.push(`sm.product_id = $${params.length}`);
  }

  if (movementType) {
    params.push(movementType);
    where.push(`sm.movement_type = $${params.length}::movement_type`);
  }

  if (branchCode) {
    params.push(branchCode);
    where.push(branchPerspectiveCondition("code", `$${params.length}`));
  }

  if (effectiveLocationId) {
    params.push(effectiveLocationId);
    where.push(branchPerspectiveCondition("id", `$${params.length}::uuid`));
  }

  if (from) {
    params.push(from.toISOString());
    where.push(`${effectiveOccurredAtSql} >= $${params.length}::timestamptz`);
  }

  if (to) {
    params.push(to.toISOString());
    where.push(`${effectiveOccurredAtSql} < $${params.length}::timestamptz`);
  }

  params.push(safeLimit);

  const result = await query(
    `
      SELECT
        sm.id,
        sm.movement_type AS "movementType",
        sm.source_ref_type AS "sourceRefType",
        sm.source_ref_id AS "sourceRefId",
        source_incident.incident_code AS "sourceIncidentCode",
        source_incident.incident_description AS "sourceIncidentDescription",
        to_jsonb(source_incident) ->> 'deleted_at' AS "sourceIncidentDeletedAt",
        ${effectiveOccurredAtSql} AS "occurredAt",
        sm.occurred_at AS "originalOccurredAt",
        sm.corrected_occurred_at AS "correctedOccurredAt",
        sm.quantity,
        sm.quantity_base AS "quantityBase",
        sm.note_text AS note,
        p.id AS "productId",
        p.product_code AS "productCode",
        p.trade_name AS "tradeName",
        pl.id AS "lotId",
        pl.lot_no AS "lotNo",
        COALESCE(NULLIF(trim(sellable_pul.display_name), ''), sellable_pul.code, COALESCE(NULLIF(trim(pul.display_name), ''), pul.code, 'unit')) AS "unitLabel",
        COALESCE(NULLIF(trim(pul.display_name), ''), pul.code, 'unit') AS "movementUnitLabel",
        COALESCE(NULLIF(trim(sellable_pul.display_name), ''), sellable_pul.code, COALESCE(NULLIF(trim(pul.display_name), ''), pul.code, 'unit')) AS "sellableUnitLabel",
        COALESCE(base_pul.base_unit_symbol, 'base') AS "baseUnitLabel",
        COALESCE(NULLIF(trim(pa.full_name), ''), '') AS "patientName",
        latest_correction.reason_text AS "occurredAtCorrectionReason",
        latest_correction.edited_at AS "occurredAtCorrectedAt",
        latest_correction.edited_by_name AS "occurredAtCorrectedByName",
        latest_correction.edited_by_username AS "occurredAtCorrectedByUsername",
        from_l.code AS "fromBranchCode",
        from_l.name AS "fromBranchName",
        to_l.code AS "toBranchCode",
        to_l.name AS "toBranchName"
      FROM stock_movements sm
      JOIN products p ON p.id = sm.product_id
      LEFT JOIN product_lots pl ON pl.id = sm.lot_id
      JOIN product_unit_levels pul ON pul.id = sm.unit_level_id
      LEFT JOIN LATERAL (
        SELECT
          puls.display_name,
          puls.code
        FROM product_unit_levels puls
        WHERE puls.product_id = sm.product_id
          AND ${sellableUnitActivePredicate}
        ORDER BY puls.is_sellable DESC, puls.is_base DESC, puls.sort_order ASC, puls.created_at ASC
        LIMIT 1
      ) sellable_pul ON true
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(NULLIF(utb.name_th, ''), NULLIF(utb.name_en, ''), NULLIF(utb.symbol, ''), utb.code, 'base') AS base_unit_symbol
        FROM product_unit_levels pulb
        LEFT JOIN unit_types utb ON utb.id = pulb.unit_type_id
        WHERE pulb.product_id = sm.product_id
          AND ${baseUnitActivePredicate}
        ORDER BY pulb.is_base DESC, pulb.sort_order ASC, pulb.created_at ASC
        LIMIT 1
      ) base_pul ON true
      LEFT JOIN LATERAL (
        SELECT
          sma.reason_text,
          sma.edited_at,
          COALESCE(NULLIF(trim(u.full_name), ''), NULLIF(trim(u.username), ''), 'unknown') AS edited_by_name,
          u.username AS edited_by_username
        FROM stock_movement_occurred_at_audits sma
        LEFT JOIN users u ON u.id = sma.edited_by
        WHERE sma.movement_id = sm.id
        ORDER BY sma.edited_at DESC
        LIMIT 1
      ) latest_correction ON true
      LEFT JOIN locations from_l ON from_l.id = sm.from_location_id
      LEFT JOIN locations to_l ON to_l.id = sm.to_location_id
      LEFT JOIN dispense_lines dl ON dl.id = sm.dispense_line_id
      LEFT JOIN dispense_headers dh
        ON dh.id = COALESCE(
          dl.header_id,
          CASE
            WHEN sm.source_ref_type = 'DISPENSE_HEADER' THEN sm.source_ref_id
            ELSE NULL
          END
        )
      LEFT JOIN patients pa ON pa.id = dh.patient_id
      LEFT JOIN incident_reports source_incident
        ON sm.source_ref_type = 'INCIDENT_REPORT'
       AND source_incident.id = sm.source_ref_id
      WHERE ${where.join(" AND ")}
      ORDER BY ${effectiveOccurredAtSql} DESC, sm.created_at DESC
      LIMIT $${params.length}
    `,
    params
  );

  return res.json(result.rows);
}
