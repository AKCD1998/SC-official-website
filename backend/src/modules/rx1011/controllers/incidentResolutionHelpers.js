import { httpError } from "../utils/httpError.js";
import { parseDateOnlyInput } from "../utils/dateOnly.js";
import {
  applyStockDelta,
  assertLotBelongsToProduct,
  assertUnitLevelAllowedForLot,
  convertToBase,
  ensureProductExists,
  resolveActorUserId,
  resolveProductBaseUnitLevel,
  resolveBranchById,
  toIsoTimestamp,
  toPositiveNumeric,
  upsertPatientByPid,
} from "./helpers.js";

const INCIDENT_RESOLUTION_ACTION_TYPES = new Set([
  "STOCK_IN",
  "STOCK_OUT",
  "RETROSPECTIVE_DISPENSE",
]);

const INCIDENT_SOURCE_REF_TYPE = "INCIDENT_REPORT";

function toCleanText(value) {
  return String(value ?? "").trim();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    toCleanText(value)
  );
}

function normalizeOptionalText(value, maxLength, fieldName) {
  const text = toCleanText(value);
  if (!text) return null;
  if (maxLength && text.length > maxLength) {
    throw httpError(400, `${fieldName} must be at most ${maxLength} characters`);
  }
  return text;
}

function normalizeSexSnapshot(value) {
  const text = toCleanText(value).toUpperCase();
  if (!text) return null;
  if (["M", "MALE", "ชาย"].includes(text)) return "MALE";
  if (["F", "FEMALE", "หญิง"].includes(text)) return "FEMALE";
  if (["OTHER", "อื่น", "อื่นๆ", "อื่น ๆ"].includes(text)) return "OTHER";
  return "UNKNOWN";
}

export function normalizeIncidentResolutionPatientInput(payload = {}, { allowEmpty = true } = {}) {
  const patient = payload && typeof payload === "object" ? payload : {};
  const normalized = {
    pid: normalizeOptionalText(patient?.pid, 30, "resolutionPatient.pid"),
    fullName: normalizeOptionalText(
      patient?.fullName ?? patient?.full_name ?? patient?.name,
      255,
      "resolutionPatient.fullName"
    ),
    englishName: normalizeOptionalText(
      patient?.englishName ?? patient?.english_name,
      255,
      "resolutionPatient.englishName"
    ),
    birthDate:
      parseDateOnlyInput(patient?.birthDate ?? patient?.birth_date, "resolutionPatient.birthDate", {
        allowEmpty: true,
      }) || null,
    sex: normalizeSexSnapshot(patient?.sex),
    cardIssuePlace: normalizeOptionalText(
      patient?.cardIssuePlace ?? patient?.card_issue_place,
      255,
      "resolutionPatient.cardIssuePlace"
    ),
    cardIssuedDate:
      parseDateOnlyInput(
        patient?.cardIssuedDate ?? patient?.card_issued_date,
        "resolutionPatient.cardIssuedDate",
        { allowEmpty: true }
      ) || null,
    cardExpiryDate:
      parseDateOnlyInput(
        patient?.cardExpiryDate ?? patient?.card_expiry_date,
        "resolutionPatient.cardExpiryDate",
        { allowEmpty: true }
      ) || null,
    addressText: normalizeOptionalText(
      patient?.addressText ?? patient?.address_text ?? patient?.address_raw_text,
      1000,
      "resolutionPatient.addressText"
    ),
  };

  const hasAnyValue = Object.values(normalized).some(Boolean);
  if (!hasAnyValue && allowEmpty) {
    return null;
  }

  if (!normalized.pid) {
    throw httpError(400, "resolutionPatient.pid is required for retrospective dispense");
  }
  if (!normalized.fullName) {
    throw httpError(400, "resolutionPatient.fullName is required for retrospective dispense");
  }

  return normalized;
}

export function normalizeIncidentResolutionActionInput(action, index) {
  const rowLabel = `resolutionActions[${index}]`;
  const actionType = toCleanText(action?.actionType ?? action?.action_type).toUpperCase();
  const productId = toCleanText(action?.productId ?? action?.product_id);
  const lotId = toCleanText(action?.lotId ?? action?.lot_id);
  const unitLevelId = toCleanText(action?.unitLevelId ?? action?.unit_level_id);
  const qty = toPositiveNumeric(action?.qty, `${rowLabel}.qty`);
  const unitLabel = normalizeOptionalText(
    action?.unitLabel ?? action?.unit_label ?? action?.unitLabelSnapshot ?? action?.unit_label_snapshot,
    160,
    `${rowLabel}.unitLabel`
  );
  const lotNoSnapshot = normalizeOptionalText(
    action?.lotNoSnapshot ?? action?.lot_no_snapshot ?? action?.lotNo ?? action?.lot_no,
    120,
    `${rowLabel}.lotNoSnapshot`
  );
  const expDateSnapshot =
    parseDateOnlyInput(action?.expDateSnapshot ?? action?.exp_date_snapshot, `${rowLabel}.expDateSnapshot`, {
      allowEmpty: true,
    }) || null;
  const note = normalizeOptionalText(action?.note ?? action?.noteText ?? action?.note_text, 2000, `${rowLabel}.note`);

  if (!INCIDENT_RESOLUTION_ACTION_TYPES.has(actionType)) {
    throw httpError(400, `${rowLabel}.actionType is invalid`);
  }
  if (!productId || !isUuid(productId)) {
    throw httpError(400, `${rowLabel}.productId must be a valid UUID`);
  }
  if (lotId && !isUuid(lotId)) {
    throw httpError(400, `${rowLabel}.lotId must be a valid UUID`);
  }
  if (unitLevelId && !isUuid(unitLevelId)) {
    throw httpError(400, `${rowLabel}.unitLevelId must be a valid UUID`);
  }
  if (!unitLevelId && !unitLabel) {
    throw httpError(400, `${rowLabel}.unitLevelId or unitLabel is required`);
  }

  return {
    actionType,
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

async function resolveResolutionProductSnapshot(client, productId) {
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

async function resolveResolutionLotSnapshot(
  client,
  { productId, lotId, lotNoSnapshot, expDateSnapshot }
) {
  if (lotId) {
    await assertLotBelongsToProduct(client, productId, lotId);
    const result = await client.query(
      `
        SELECT
          id,
          lot_no AS "lotNo",
          exp_date::text AS "expDate"
        FROM product_lots
        WHERE id = $1::uuid
          AND product_id = $2::uuid
        LIMIT 1
      `,
      [lotId, productId]
    );
    if (!result.rows[0]) {
      throw httpError(404, `Product lot not found: ${lotId}`);
    }
    return result.rows[0];
  }

  if (!lotNoSnapshot || !expDateSnapshot) {
    return null;
  }

  const result = await client.query(
    `
      SELECT
        id,
        lot_no AS "lotNo",
        exp_date::text AS "expDate"
      FROM product_lots
      WHERE product_id = $1::uuid
        AND lot_no = $2
        AND exp_date = $3::date
      LIMIT 1
    `,
    [productId, lotNoSnapshot, expDateSnapshot]
  );

  if (!result.rows[0]) {
    throw httpError(404, `Product lot not found: ${lotNoSnapshot} (exp ${expDateSnapshot})`);
  }
  return result.rows[0];
}

async function resolveResolutionUnitSnapshot(client, { productId, unitLevelId, unitLabel }) {
  if (unitLevelId) {
    const result = await client.query(
      `
        SELECT
          pul.id,
          pul.code,
          pul.display_name,
          pul.unit_key,
          ut.code AS "unitTypeCode",
          COALESCE(
            NULLIF(TRIM(pul.display_name), ''),
            NULLIF(TRIM(ut.symbol), ''),
            ut.code,
            pul.code,
            'unit'
          ) AS "unitLabel"
        FROM product_unit_levels pul
        LEFT JOIN unit_types ut ON ut.id = pul.unit_type_id
        WHERE pul.product_id = $1::uuid
          AND pul.id = $2::uuid
        LIMIT 1
      `,
      [productId, unitLevelId]
    );
    if (!result.rows[0]) {
      throw httpError(404, `Product unit level not found: ${unitLevelId}`);
    }
    return result.rows[0];
  }

  const normalizedUnitLabel = toCleanText(unitLabel);
  const result = await client.query(
    `
      SELECT
        pul.id,
        pul.code,
        pul.display_name,
        pul.unit_key,
        ut.code AS "unitTypeCode",
        COALESCE(
          NULLIF(TRIM(pul.display_name), ''),
          NULLIF(TRIM(ut.symbol), ''),
          ut.code,
          pul.code,
          'unit'
        ) AS "unitLabel"
      FROM product_unit_levels pul
      LEFT JOIN unit_types ut ON ut.id = pul.unit_type_id
      WHERE pul.product_id = $1::uuid
        AND (
          LOWER(COALESCE(NULLIF(TRIM(pul.display_name), ''), '')) = LOWER($2)
          OR LOWER(COALESCE(NULLIF(TRIM(pul.code), ''), '')) = LOWER($2)
          OR LOWER(COALESCE(NULLIF(TRIM(ut.symbol), ''), '')) = LOWER($2)
          OR LOWER(COALESCE(NULLIF(TRIM(ut.code), ''), '')) = LOWER($2)
        )
      ORDER BY pul.is_sellable DESC, pul.is_base DESC, pul.sort_order ASC, pul.created_at ASC
      LIMIT 1
    `,
    [productId, normalizedUnitLabel]
  );

  if (!result.rows[0]) {
    throw httpError(404, `Product unit level not found for label: ${normalizedUnitLabel || "-"}`);
  }
  return result.rows[0];
}

function buildResolutionMetadataTag(incident, actionType) {
  const meta = [
    `source=${INCIDENT_SOURCE_REF_TYPE}`,
    `incidentCode=${toCleanText(incident?.incidentCode) || "-"}`,
    `actionType=${actionType}`,
  ];
  return `[${meta.join(" ")}]`;
}

function buildResolutionNote({ incident, actionType, note, extraLines = [] }) {
  const parts = [];
  const cleanNote = toCleanText(note);
  if (cleanNote) {
    parts.push(cleanNote);
  }

  const filteredExtraLines = (Array.isArray(extraLines) ? extraLines : [])
    .map((entry) => toCleanText(entry))
    .filter(Boolean);
  if (filteredExtraLines.length) {
    parts.push(filteredExtraLines.join("\n"));
  }

  parts.push(buildResolutionMetadataTag(incident, actionType));
  return parts.join("\n\n");
}

function buildRetrospectiveDispenseHeaderNote(incident, patient) {
  return buildResolutionNote({
    incident,
    actionType: "RETROSPECTIVE_DISPENSE",
    note: incident?.noteText,
    extraLines: [
      `ย้อนหลังจาก incident ${toCleanText(incident?.incidentCode) || "-"}`,
      `ผู้รับมอบยา: ${toCleanText(patient?.fullName) || "-"}`,
      `เลขประจำตัวประชาชน: ${toCleanText(patient?.pid) || "-"}`,
      patient?.englishName ? `ชื่อภาษาอังกฤษ: ${patient.englishName}` : "",
      patient?.addressText ? `ที่อยู่: ${patient.addressText}` : "",
    ],
  });
}

function buildRetrospectiveDispenseLineNote(incident, action) {
  return buildResolutionNote({
    incident,
    actionType: "RETROSPECTIVE_DISPENSE",
    note: action?.note,
    extraLines: [
      `สร้างย้อนหลังจาก incident ${toCleanText(incident?.incidentCode) || "-"}`,
      action?.lotNoSnapshot ? `lotNo=${action.lotNoSnapshot}` : "",
    ],
  });
}

function isDuplicateResolutionAction(existingActions, nextAction) {
  return existingActions.some((action) => {
    const sameQty = Math.abs(Number(action?.qty || 0) - Number(nextAction?.qty || 0)) < 0.0001;
    return (
      toCleanText(action?.actionType).toUpperCase() === toCleanText(nextAction?.actionType).toUpperCase() &&
      toCleanText(action?.productId) === toCleanText(nextAction?.productId) &&
      toCleanText(action?.lotId) === toCleanText(nextAction?.lotId) &&
      toCleanText(action?.lotNoSnapshot) === toCleanText(nextAction?.lotNoSnapshot) &&
      toCleanText(action?.unitLevelId) === toCleanText(nextAction?.unitLevelId) &&
      toCleanText(action?.unitLabelSnapshot) === toCleanText(nextAction?.unitLabel) &&
      sameQty
    );
  });
}

async function insertResolutionActionRow(client, row) {
  const result = await client.query(
    `
      INSERT INTO incident_report_resolution_actions (
        incident_report_id,
        line_no,
        action_type,
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
        patient_pid_snapshot,
        patient_full_name_snapshot,
        patient_english_name_snapshot,
        patient_birth_date_snapshot,
        patient_sex_snapshot,
        patient_card_issue_place_snapshot,
        patient_card_issued_date_snapshot,
        patient_card_expiry_date_snapshot,
        patient_address_text_snapshot,
        applied_stock_movement_id,
        applied_dispense_header_id,
        applied_dispense_line_id,
        applied_by_user_id,
        applied_at,
        created_at
      )
      VALUES (
        $1::uuid,
        $2,
        $3,
        $4::uuid,
        $5::uuid,
        $6::uuid,
        $7,
        $8,
        $9,
        $10::date,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        $17::date,
        $18,
        $19,
        $20::date,
        $21::date,
        $22,
        $23::uuid,
        $24::uuid,
        $25::uuid,
        $26::uuid,
        $27::timestamptz,
        now()
      )
      RETURNING id
    `,
    [
      row.incidentReportId,
      row.lineNo,
      row.actionType,
      row.productId,
      row.lotId || null,
      row.unitLevelId || null,
      row.productCodeSnapshot || null,
      row.productNameSnapshot || "-",
      row.lotNoSnapshot || null,
      row.expDateSnapshot || null,
      row.qty,
      row.unitLabelSnapshot || null,
      row.noteText || null,
      row.patientPidSnapshot || null,
      row.patientFullNameSnapshot || null,
      row.patientEnglishNameSnapshot || null,
      row.patientBirthDateSnapshot || null,
      row.patientSexSnapshot || null,
      row.patientCardIssuePlaceSnapshot || null,
      row.patientCardIssuedDateSnapshot || null,
      row.patientCardExpiryDateSnapshot || null,
      row.patientAddressTextSnapshot || null,
      row.appliedStockMovementId || null,
      row.appliedDispenseHeaderId || null,
      row.appliedDispenseLineId || null,
      row.appliedByUserId || null,
      row.appliedAt || null,
    ]
  );

  return result.rows[0]?.id || null;
}

export async function applyIncidentResolutionActions(
  client,
  {
    incident,
    resolutionActions = [],
    resolutionPatient = null,
    appliedByUserId = null,
  }
) {
  const actions = Array.isArray(resolutionActions) ? resolutionActions : [];
  if (!actions.length) {
    return [];
  }

  const actorUserId = await resolveActorUserId(client, appliedByUserId);
  const branch = await resolveBranchById(client, incident.branchId);
  const happenedAt = toIsoTimestamp(incident.happenedAt);
  const existingActions = Array.isArray(incident?.resolutionActions) ? incident.resolutionActions : [];
  const retrospectivePatient = actions.some((action) => action.actionType === "RETROSPECTIVE_DISPENSE")
    ? normalizeIncidentResolutionPatientInput(resolutionPatient, { allowEmpty: false })
    : null;
  const appliedAt = new Date().toISOString();
  const createdActionIds = [];
  let nextActionLineNo =
    existingActions.reduce((maxValue, row) => Math.max(maxValue, Number(row?.lineNo || 0)), 0) + 1;
  const retrospectiveActions = [];

  for (const action of actions) {
    if (isDuplicateResolutionAction(existingActions, action)) {
      throw httpError(
        409,
        `Duplicate incident resolution action detected for incident ${toCleanText(incident?.incidentCode) || "-"}`
      );
    }

    await ensureProductExists(client, action.productId);
    const product = await resolveResolutionProductSnapshot(client, action.productId);
    const lot = await resolveResolutionLotSnapshot(client, {
      productId: action.productId,
      lotId: action.lotId,
      lotNoSnapshot: action.lotNoSnapshot,
      expDateSnapshot: action.expDateSnapshot,
    });
    const unitLevel = await resolveResolutionUnitSnapshot(client, {
      productId: action.productId,
      unitLevelId: action.unitLevelId,
      unitLabel: action.unitLabel,
    });
    const baseUnitLevel = await resolveProductBaseUnitLevel(client, action.productId);

    await assertUnitLevelAllowedForLot(client, {
      productId: action.productId,
      lotId: lot?.id || null,
      unitLevelId: unitLevel.id,
    });

    const quantityBase = convertToBase(action.qty, unitLevel);
    const actionBaseRow = {
      incidentReportId: incident.id,
      lineNo: nextActionLineNo,
      actionType: action.actionType,
      productId: action.productId,
      lotId: lot?.id || null,
      unitLevelId: unitLevel.id,
      productCodeSnapshot: toCleanText(product.productCode) || null,
      productNameSnapshot: toCleanText(product.tradeName) || "-",
      lotNoSnapshot: toCleanText(lot?.lotNo) || action.lotNoSnapshot || null,
      expDateSnapshot: lot?.expDate || action.expDateSnapshot || null,
      qty: action.qty,
      unitLabelSnapshot: toCleanText(unitLevel.unitLabel) || action.unitLabel || null,
      noteText: action.note || null,
      patientPidSnapshot: action.actionType === "RETROSPECTIVE_DISPENSE" ? retrospectivePatient?.pid || null : null,
      patientFullNameSnapshot:
        action.actionType === "RETROSPECTIVE_DISPENSE" ? retrospectivePatient?.fullName || null : null,
      patientEnglishNameSnapshot:
        action.actionType === "RETROSPECTIVE_DISPENSE" ? retrospectivePatient?.englishName || null : null,
      patientBirthDateSnapshot:
        action.actionType === "RETROSPECTIVE_DISPENSE" ? retrospectivePatient?.birthDate || null : null,
      patientSexSnapshot:
        action.actionType === "RETROSPECTIVE_DISPENSE" ? retrospectivePatient?.sex || null : null,
      patientCardIssuePlaceSnapshot:
        action.actionType === "RETROSPECTIVE_DISPENSE" ? retrospectivePatient?.cardIssuePlace || null : null,
      patientCardIssuedDateSnapshot:
        action.actionType === "RETROSPECTIVE_DISPENSE" ? retrospectivePatient?.cardIssuedDate || null : null,
      patientCardExpiryDateSnapshot:
        action.actionType === "RETROSPECTIVE_DISPENSE" ? retrospectivePatient?.cardExpiryDate || null : null,
      patientAddressTextSnapshot:
        action.actionType === "RETROSPECTIVE_DISPENSE" ? retrospectivePatient?.addressText || null : null,
      appliedByUserId: actorUserId,
      appliedAt,
    };

    if (action.actionType === "STOCK_IN") {
      const noteText = buildResolutionNote({
        incident,
        actionType: action.actionType,
        note: action.note,
        extraLines: [`เพิ่ม stock ให้สาขา ${toCleanText(branch.code) || "-"}`],
      });

      const movementResult = await client.query(
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
            'RECEIVE',
            NULL,
            $1::uuid,
            $2::uuid,
            $3::uuid,
            $4,
            $5,
            $6::uuid,
            $7,
            $8::uuid,
            $9::timestamptz,
            $10::uuid,
            $11
          )
          RETURNING id
        `,
        [
          branch.id,
          action.productId,
          lot?.id || null,
          action.qty,
          quantityBase,
          unitLevel.id,
          INCIDENT_SOURCE_REF_TYPE,
          incident.id,
          happenedAt,
          actorUserId,
          noteText,
        ]
      );

      await applyStockDelta(client, {
        branchId: branch.id,
        productId: action.productId,
        lotId: lot?.id || null,
        baseUnitLevelId: baseUnitLevel.id,
        deltaQtyBase: quantityBase,
      });

      createdActionIds.push(
        await insertResolutionActionRow(client, {
          ...actionBaseRow,
          noteText,
          appliedStockMovementId: movementResult.rows[0]?.id || null,
        })
      );
    } else if (action.actionType === "STOCK_OUT") {
      const noteText = buildResolutionNote({
        incident,
        actionType: action.actionType,
        note: action.note,
        extraLines: [`ลด stock ของสาขา ${toCleanText(branch.code) || "-"}`],
      });

      await applyStockDelta(client, {
        branchId: branch.id,
        productId: action.productId,
        lotId: lot?.id || null,
        baseUnitLevelId: baseUnitLevel.id,
        deltaQtyBase: -quantityBase,
      });

      const movementResult = await client.query(
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
            'DISPENSE',
            $1::uuid,
            NULL,
            $2::uuid,
            $3::uuid,
            $4,
            $5,
            $6::uuid,
            $7,
            $8::uuid,
            $9::timestamptz,
            $10::uuid,
            $11
          )
          RETURNING id
        `,
        [
          branch.id,
          action.productId,
          lot?.id || null,
          action.qty,
          -quantityBase,
          unitLevel.id,
          INCIDENT_SOURCE_REF_TYPE,
          incident.id,
          happenedAt,
          actorUserId,
          noteText,
        ]
      );

      createdActionIds.push(
        await insertResolutionActionRow(client, {
          ...actionBaseRow,
          noteText,
          appliedStockMovementId: movementResult.rows[0]?.id || null,
        })
      );
    } else {
      retrospectiveActions.push({
        action,
        actionBaseRow,
        product,
        lot,
        unitLevel,
        baseUnitLevel,
        quantityBase,
      });
    }

    nextActionLineNo += 1;
  }

  if (retrospectiveActions.length) {
    const patientId = await upsertPatientByPid(client, {
      pid: retrospectivePatient.pid,
      fullName: retrospectivePatient.fullName,
      birthDate: retrospectivePatient.birthDate,
      sex: retrospectivePatient.sex,
      cardIssuePlace: retrospectivePatient.cardIssuePlace,
      cardIssuedDate: retrospectivePatient.cardIssuedDate,
      cardExpiryDate: retrospectivePatient.cardExpiryDate,
      addressText: retrospectivePatient.addressText,
    });

    const headerNote = buildRetrospectiveDispenseHeaderNote(incident, retrospectivePatient);
    const headerResult = await client.query(
      `
        INSERT INTO dispense_headers (
          branch_id,
          patient_id,
          pharmacist_user_id,
          dispensed_at,
          note_text,
          created_by,
          created_at,
          updated_at
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4::timestamptz,
          $5,
          $3::uuid,
          now(),
          now()
        )
        RETURNING id
      `,
      [branch.id, patientId, actorUserId, happenedAt, headerNote]
    );

    const dispenseHeaderId = headerResult.rows[0]?.id || null;
    let dispenseLineNo = 1;

    for (const preparedAction of retrospectiveActions) {
      const lineNote = buildRetrospectiveDispenseLineNote(incident, preparedAction.action);
      const lineResult = await client.query(
        `
          INSERT INTO dispense_lines (
            header_id,
            line_no,
            product_id,
            lot_id,
            unit_level_id,
            quantity,
            note_text
          )
          VALUES (
            $1::uuid,
            $2,
            $3::uuid,
            $4::uuid,
            $5::uuid,
            $6,
            $7
          )
          RETURNING id
        `,
        [
          dispenseHeaderId,
          dispenseLineNo,
          preparedAction.action.productId,
          preparedAction.lot?.id || null,
          preparedAction.unitLevel.id,
          preparedAction.action.qty,
          lineNote,
        ]
      );
      const dispenseLineId = lineResult.rows[0]?.id || null;

      await applyStockDelta(client, {
        branchId: branch.id,
        productId: preparedAction.action.productId,
        lotId: preparedAction.lot?.id || null,
        baseUnitLevelId: preparedAction.baseUnitLevel.id,
        deltaQtyBase: -preparedAction.quantityBase,
      });

      const movementResult = await client.query(
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
            dispense_line_id,
            source_ref_type,
            source_ref_id,
            occurred_at,
            created_by,
            note_text
          )
          VALUES (
            'DISPENSE',
            $1::uuid,
            NULL,
            $2::uuid,
            $3::uuid,
            $4,
            $5,
            $6::uuid,
            $7::uuid,
            $8,
            $9::uuid,
            $10::timestamptz,
            $11::uuid,
            $12
          )
          RETURNING id
        `,
        [
          branch.id,
          preparedAction.action.productId,
          preparedAction.lot?.id || null,
          preparedAction.action.qty,
          -preparedAction.quantityBase,
          preparedAction.unitLevel.id,
          dispenseLineId,
          INCIDENT_SOURCE_REF_TYPE,
          incident.id,
          happenedAt,
          actorUserId,
          headerNote,
        ]
      );

      createdActionIds.push(
        await insertResolutionActionRow(client, {
          ...preparedAction.actionBaseRow,
          noteText: lineNote,
          appliedStockMovementId: movementResult.rows[0]?.id || null,
          appliedDispenseHeaderId: dispenseHeaderId,
          appliedDispenseLineId: dispenseLineId,
        })
      );

      dispenseLineNo += 1;
    }
  }

  return createdActionIds.filter(Boolean);
}

export { INCIDENT_RESOLUTION_ACTION_TYPES };
