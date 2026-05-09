import { query, withTransaction } from "../db/pool.js";
import { httpError } from "../utils/httpError.js";
import { formatDateOnlyDisplay, parseDateOnlyInput } from "../utils/dateOnly.js";
import {
  buildUnitLevelKey,
  hasProductLotAllowedUnitLevelsTable,
  hasProductUnitLevelsIsActiveColumn,
  productUnitLevelsActiveCompatPredicate,
  productUnitLevelsInactiveCompatPredicate,
  productUnitLevelsIsActiveCompatExpression,
} from "./helpers.js";

const INGREDIENT_CODE_MAX_LENGTH = 80;
const LOCATION_CODE_MAX_LENGTH = 30;
const PRODUCT_UNIT_LEVEL_CODE_MAX_LENGTH = 50;
const UNIT_LEVEL_DEFAULT_CODE = "SELLABLE";
const INGREDIENT_UNIT_TYPE_CODES = [
  "MG",
  "MCG",
  "G",
  "ML",
  "L",
  "TABLET",
  "TAB",
  "CAPSULE",
  "CAP",
  "INHALATION",
];
let hasProductLotEditAuditsTableCache = null;
let hasProductLotNormalizationAuditsTableCache = null;

function buildProductUnitLevelsIsActiveSelect(alias, outputAlias = "isActive") {
  return `${productUnitLevelsIsActiveCompatExpression(alias)} AS "${outputAlias}"`;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    toCleanText(value)
  );
}

function normalizeDateOnlyQueryValue(value, fieldName) {
  return parseDateOnlyInput(value, fieldName, { allowEmpty: true });
}

function hasOwnField(objectValue, key) {
  return Object.prototype.hasOwnProperty.call(objectValue || {}, key);
}

function toCleanText(value) {
  return String(value ?? "").trim();
}

function parseBoolean(value, fallback = true) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return fallback;
}

function parsePositiveNumber(value, fieldName) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw httpError(400, `${fieldName} must be a positive number`);
  }
  return numeric;
}

function parseOptionalNonNegativeNumber(value, fieldName) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw httpError(400, `${fieldName} must be a non-negative number`);
  }
  return numeric;
}

async function hasProductLotEditAuditsTable(db) {
  if (hasProductLotEditAuditsTableCache === true) {
    return true;
  }

  const result = await db.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'product_lot_edit_audits'
      LIMIT 1
    `
  );

  if (result.rows[0]) {
    hasProductLotEditAuditsTableCache = true;
    return true;
  }

  return false;
}

async function hasProductLotNormalizationAuditsTable(db) {
  if (hasProductLotNormalizationAuditsTableCache === true) {
    return true;
  }

  const result = await db.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'product_lot_normalization_audits'
      LIMIT 1
    `
  );

  if (result.rows[0]) {
    hasProductLotNormalizationAuditsTableCache = true;
    return true;
  }

  return false;
}

async function hasPublicTable(db, tableName) {
  const safeTableName = toCleanText(tableName);
  if (!safeTableName) return false;
  const result = await db.query(`SELECT to_regclass($1) IS NOT NULL AS "exists"`, [
    `public.${safeTableName}`,
  ]);
  return Boolean(result.rows[0]?.exists);
}

function normalizeLotMetadataUpdateInput(body = {}) {
  const lotNo = toCleanText(body?.lotNo ?? body?.lot_no);
  const mfgDate =
    parseDateOnlyInput(body?.mfgDate ?? body?.mfg_date, "mfgDate", { allowEmpty: true }) || null;
  const expDate = parseDateOnlyInput(body?.expDate ?? body?.exp_date, "expDate", {
    allowEmpty: false,
  });
  const reason = toCleanText(body?.reason ?? body?.reasonText ?? body?.reason_text);

  if (!lotNo) {
    throw httpError(400, "lotNo is required");
  }
  if (!reason) {
    throw httpError(400, "reason is required");
  }
  if (mfgDate && expDate < mfgDate) {
    throw httpError(400, "expDate must be the same date or later than mfgDate");
  }

  return {
    lotNo,
    mfgDate,
    expDate,
    reason,
  };
}

function normalizeLotNormalizationInput(body = {}) {
  const sourceLotId = toCleanText(body?.sourceLotId ?? body?.source_lot_id ?? body?.lotId ?? body?.lot_id);
  const targetLotId = toCleanText(body?.targetLotId ?? body?.target_lot_id);
  const targetLotNo = toCleanText(body?.targetLotNo ?? body?.target_lot_no ?? body?.lotNo ?? body?.lot_no);
  const targetMfgDate =
    parseDateOnlyInput(body?.targetMfgDate ?? body?.target_mfg_date ?? body?.mfgDate ?? body?.mfg_date, "targetMfgDate", {
      allowEmpty: true,
    }) || null;
  const targetExpDate = parseDateOnlyInput(
    body?.targetExpDate ?? body?.target_exp_date ?? body?.expDate ?? body?.exp_date,
    "targetExpDate",
    { allowEmpty: false }
  );
  const reason = toCleanText(body?.reason ?? body?.reasonText ?? body?.reason_text);

  if (!sourceLotId || !isUuid(sourceLotId)) {
    throw httpError(400, "sourceLotId must be a valid UUID");
  }
  if (targetLotId && !isUuid(targetLotId)) {
    throw httpError(400, "targetLotId must be a valid UUID");
  }
  if (!targetLotNo) {
    throw httpError(400, "targetLotNo is required");
  }
  if (targetMfgDate && targetExpDate < targetMfgDate) {
    throw httpError(400, "targetExpDate must be the same date or later than targetMfgDate");
  }
  if (!reason) {
    throw httpError(400, "reason is required");
  }

  return {
    sourceLotId,
    targetLotId,
    targetLotNo,
    targetMfgDate,
    targetExpDate,
    reason,
  };
}

function buildIngredientCodeBase(nameEn) {
  const normalized = toCleanText(nameEn)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = normalized || "INGREDIENT";
  return base.slice(0, INGREDIENT_CODE_MAX_LENGTH - 4);
}

function buildLocationCodeBase(name) {
  const normalized = toCleanText(name)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = normalized || "MFR";
  const maxBaseLength = LOCATION_CODE_MAX_LENGTH - 4;
  return base.slice(0, maxBaseLength);
}

function composeGenericName(ingredients) {
  const names = ingredients
    .map((ingredient) => toCleanText(ingredient.nameEn))
    .filter(Boolean);
  return names.join(" + ");
}

function normalizeIngredientsInput(rawIngredients) {
  if (!Array.isArray(rawIngredients)) {
    throw httpError(400, "ingredients must be an array");
  }

  return rawIngredients
    .map((row, index) => {
      const source = row && typeof row === "object" ? row : {};
      const activeIngredientId = toCleanText(
        source.activeIngredientId ?? source.ingredientId ?? source.active_ingredient_id
      );
      const activeIngredientCode = toCleanText(
        source.activeIngredientCode ?? source.ingredientCode ?? source.code
      ).toUpperCase();
      const nameEn = toCleanText(source.nameEn ?? source.name ?? source.activeIngredientName)
        .toUpperCase();
      const nameTh = toCleanText(source.nameTh ?? source.activeIngredientNameTh);
      const strengthNumeratorRaw =
        source.strengthNumerator ?? source.numerator ?? source.strength_value ?? "";
      const numeratorUnitCode = toCleanText(
        source.numeratorUnitCode ?? source.numeratorUnit ?? source.strengthUnitCode
      ).toUpperCase();
      const strengthDenominatorRaw =
        source.strengthDenominator ?? source.denominator ?? source.denominatorValue ?? "";
      const denominatorUnitCode = toCleanText(
        source.denominatorUnitCode ?? source.denominatorUnit
      ).toUpperCase();
      const rowNumber = index + 1;

      const isBlankRow =
        !activeIngredientId &&
        !activeIngredientCode &&
        !nameEn &&
        !nameTh &&
        String(strengthNumeratorRaw ?? "").trim() === "" &&
        !numeratorUnitCode &&
        String(strengthDenominatorRaw ?? "").trim() === "" &&
        !denominatorUnitCode;
      if (isBlankRow) return null;

      if (!nameEn && !activeIngredientCode && !activeIngredientId) {
        throw httpError(
          400,
          `ingredients[${rowNumber}] requires nameEn, activeIngredientCode, or activeIngredientId`
        );
      }

      const strengthNumerator = parsePositiveNumber(
        strengthNumeratorRaw,
        `ingredients[${rowNumber}].strengthNumerator`
      );

      if (!numeratorUnitCode) {
        throw httpError(400, `ingredients[${rowNumber}].numeratorUnitCode is required`);
      }

      const hasDenominatorValue = String(strengthDenominatorRaw ?? "").trim() !== "";
      const hasDenominatorUnit = Boolean(denominatorUnitCode);
      if (hasDenominatorValue !== hasDenominatorUnit) {
        throw httpError(
          400,
          `ingredients[${rowNumber}] denominator requires both strengthDenominator and denominatorUnitCode`
        );
      }

      const strengthDenominator = hasDenominatorValue
        ? parsePositiveNumber(
            strengthDenominatorRaw,
            `ingredients[${rowNumber}].strengthDenominator`
          )
        : null;

      return {
        activeIngredientId: activeIngredientId || null,
        activeIngredientCode: activeIngredientCode || null,
        nameEn: nameEn || activeIngredientCode || null,
        nameTh: nameTh || null,
        strengthNumerator,
        numeratorUnitCode,
        strengthDenominator,
        denominatorUnitCode: hasDenominatorUnit ? denominatorUnitCode : null,
      };
    })
    .filter(Boolean);
}

async function hydrateIngredientsByActiveIngredientId(db, ingredients) {
  const ids = [...new Set(ingredients.map((ingredient) => ingredient.activeIngredientId).filter(Boolean))];
  if (!ids.length) return ingredients;

  const result = await db.query(
    `
      SELECT
        id::text AS id,
        code,
        name_en,
        name_th
      FROM active_ingredients
      WHERE id::text = ANY($1::text[])
    `,
    [ids]
  );

  const ingredientsById = new Map(result.rows.map((row) => [row.id, row]));

  return ingredients.map((ingredient, index) => {
    if (!ingredient.activeIngredientId) return ingredient;

    const resolved = ingredientsById.get(ingredient.activeIngredientId);
    if (!resolved) {
      throw httpError(
        400,
        `ingredients[${index + 1}].activeIngredientId not found: ${ingredient.activeIngredientId}`
      );
    }

    return {
      ...ingredient,
      activeIngredientCode: ingredient.activeIngredientCode || resolved.code,
      nameEn: ingredient.nameEn || resolved.name_en,
      nameTh: ingredient.nameTh || resolved.name_th || null,
    };
  });
}

function normalizeReportGroupCodesInput(body) {
  const source = body && typeof body === "object" ? body : {};
  const hasArray = hasOwnField(source, "reportGroupCodes");
  const hasSingle =
    hasOwnField(source, "reportGroupCode") ||
    hasOwnField(source, "report_group_code") ||
    hasOwnField(source, "reportType");

  let rawCodes = [];
  if (hasArray && Array.isArray(source.reportGroupCodes)) {
    rawCodes = source.reportGroupCodes;
  } else if (hasSingle) {
    rawCodes = [source.reportGroupCode ?? source.report_group_code ?? source.reportType];
  }

  const codes = [...new Set(rawCodes.map((code) => toCleanText(code).toUpperCase()).filter(Boolean))];
  return {
    hasReportGroupField: hasArray || hasSingle,
    reportGroupCodes: codes,
  };
}

function normalizePackagingDisplayName(value) {
  return toCleanText(value).replace(/\s+/g, " ");
}

function extractPackagingContainerLabel(displayName) {
  const normalized = normalizePackagingDisplayName(displayName);
  if (!normalized) return "";
  const firstPart = normalized.split(/\s*[xX×]\s*/u)[0] || "";
  const containerMatch = firstPart.match(/^1\s+(.+)$/u);
  return normalizePackagingDisplayName(containerMatch?.[1] || firstPart);
}

function formatPackagingQuantity(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  return Number.isInteger(numeric) ? String(numeric) : String(numeric).replace(/\.?0+$/, "");
}

function extractQuantityPerBaseFromUnitKey(unitKey) {
  const match = String(unitKey || "").match(/qpb=([0-9]+(?:\.[0-9]+)?)/i);
  if (!match?.[1]) return null;
  const numeric = Number(match[1]);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function inferLegacyQuantityPerBase(displayName, isBase) {
  if (isBase) return 1;
  const matches = [...String(displayName || "").matchAll(/[0-9]+(?:\.[0-9]+)?/g)].map((entry) =>
    Number(entry[0])
  );
  if (matches.length >= 2) return matches[1];
  if (matches.length === 1) return matches[0];
  return 1;
}

function resolvePackagingLevelQuantityPerBase(level) {
  const explicitQuantity = Number(
    level?.quantityPerBase ??
      level?.quantity_per_base ??
      extractQuantityPerBaseFromUnitKey(level?.unitKey ?? level?.unit_key)
  );
  if (Number.isFinite(explicitQuantity) && explicitQuantity > 0) {
    return explicitQuantity;
  }
  return inferLegacyQuantityPerBase(level?.displayName ?? level?.display_name, level?.isBase ?? level?.is_base);
}

function toPackagingStructuralKey(level) {
  return [
    toCleanText(level?.unitTypeCode || level?.unit_type_code).toUpperCase(),
    formatPackagingQuantity(resolvePackagingLevelQuantityPerBase(level)),
    parseBoolean(level?.isBase ?? level?.is_base, false) ? "BASE" : "NON_BASE",
  ].join("|");
}

function normalizeReportReceiveUnitSelectionInput(body = {}) {
  const hasField =
    hasOwnField(body, "reportReceiveUnitLevelId") ||
    hasOwnField(body, "report_receive_unit_level_id") ||
    hasOwnField(body, "reportReceiveUnitKey") ||
    hasOwnField(body, "report_receive_unit_key");

  const levelId = toCleanText(body.reportReceiveUnitLevelId ?? body.report_receive_unit_level_id);
  const selectionKey = toCleanText(body.reportReceiveUnitKey ?? body.report_receive_unit_key);

  if (levelId && !isUuid(levelId)) {
    throw httpError(400, "reportReceiveUnitLevelId must be a valid UUID");
  }

  return {
    hasField,
    levelId: levelId || null,
    selectionKey: selectionKey || null,
  };
}

function normalizePackagingLevelInput(rawLevel, index) {
  const source = rawLevel && typeof rawLevel === "object" ? rawLevel : {};
  const displayName = normalizePackagingDisplayName(
    source.displayName ?? source.display_name ?? source.packageSize ?? source.packageLabel
  );
  const unitTypeCode = toCleanText(source.unitTypeCode ?? source.unit_type_code ?? source.unit_code).toUpperCase();
  const quantityPerBaseRaw =
    source.quantityPerBase ?? source.quantity_per_base ?? source.qtyPerBase;
  const isBlankRow =
    !toCleanText(source.id) &&
    !displayName &&
    !unitTypeCode &&
    !toCleanText(source.barcode) &&
    !String(quantityPerBaseRaw ?? "").trim();

  if (isBlankRow) {
    return null;
  }

  const quantityPerBase = parsePositiveNumber(
    quantityPerBaseRaw,
    `packagingLevels[${index + 1}].quantityPerBase`
  );
  const row = {
    id: toCleanText(source.id) || null,
    displayName,
    unitTypeCode,
    barcode: toCleanText(source.barcode) || null,
    quantityPerBase,
    isBase: parseBoolean(source.isBase ?? source.is_base, false),
    isSellable: parseBoolean(source.isSellable ?? source.is_sellable, false),
    sortOrder: index + 1,
  };

  if (!row.displayName) {
    throw httpError(400, `packagingLevels[${index + 1}].displayName is required`);
  }
  if (!row.unitTypeCode) {
    throw httpError(400, `packagingLevels[${index + 1}].unitTypeCode is required`);
  }

  return row;
}

function normalizePackagingLevelsInput(body) {
  const source = body && typeof body === "object" ? body : {};
  const hasPackagingLevelsField =
    hasOwnField(source, "packagingLevels") || hasOwnField(source, "packaging_levels");

  if (!hasPackagingLevelsField) {
    return {
      hasPackagingLevelsField: false,
      packagingLevels: [],
    };
  }

  const rawLevels = hasOwnField(source, "packagingLevels")
    ? source.packagingLevels
    : source.packaging_levels;

  if (!Array.isArray(rawLevels)) {
    throw httpError(400, "packagingLevels must be an array");
  }

  const packagingLevels = rawLevels
    .map((level, index) => normalizePackagingLevelInput(level, index))
    .filter(Boolean);

  if (!packagingLevels.length) {
    throw httpError(400, "packagingLevels must contain at least one level");
  }

  const baseLevels = packagingLevels.filter((level) => level.isBase);
  if (baseLevels.length !== 1) {
    throw httpError(400, "packagingLevels must contain exactly one base level");
  }
  if (baseLevels[0].quantityPerBase !== 1) {
    throw httpError(400, "Base packaging level must have quantityPerBase = 1");
  }

  const sellableLevels = packagingLevels.filter((level) => level.isSellable);
  if (sellableLevels.length !== 1) {
    throw httpError(400, "packagingLevels must contain exactly one sellable level");
  }

  const seenIds = new Set();
  const seenStructuralKeys = new Set();
  const seenBarcodes = new Set();

  for (const [index, level] of packagingLevels.entries()) {
    if (level.id) {
      if (seenIds.has(level.id)) {
        throw httpError(400, `packagingLevels[${index + 1}] has a duplicated id`);
      }
      seenIds.add(level.id);
    }

    const structuralKey = toPackagingStructuralKey(level);
    if (seenStructuralKeys.has(structuralKey)) {
      throw httpError(400, `packagingLevels[${index + 1}] duplicates another packaging structure`);
    }
    seenStructuralKeys.add(structuralKey);

    if (level.barcode) {
      if (seenBarcodes.has(level.barcode)) {
        throw httpError(400, `packagingLevels[${index + 1}] has a duplicated barcode`);
      }
      seenBarcodes.add(level.barcode);
    }
  }

  return {
    hasPackagingLevelsField: true,
    packagingLevels,
  };
}

function normalizePackagingLevelRow(row) {
  const quantityPerBase =
    row.quantityPerBase === null || row.quantityPerBase === undefined
      ? inferLegacyQuantityPerBase(row.displayName, row.isBase)
      : Number(row.quantityPerBase);

  return {
    id: toCleanText(row.id),
    code: toCleanText(row.code),
    displayName: normalizePackagingDisplayName(row.displayName || row.display_name) || "-",
    sortOrder: Number(row.sortOrder ?? row.sort_order ?? 0),
    isBase: Boolean(row.isBase ?? row.is_base),
    isSellable: Boolean(row.isSellable ?? row.is_sellable),
    isActive: Boolean(row.isActive ?? row.is_active ?? true),
    barcode: toCleanText(row.barcode),
    quantityPerBase: Number.isFinite(quantityPerBase) && quantityPerBase > 0 ? quantityPerBase : 1,
    unitTypeCode: toCleanText(row.unitTypeCode ?? row.unit_type_code).toUpperCase(),
    unitTypeLabel: toCleanText(
      row.unitTypeLabel ?? row.unit_type_label ?? row.unitTypeCode ?? row.unit_type_code
    ),
    unitKey: toCleanText(row.unitKey ?? row.unit_key),
    price:
      row.price === null || row.price === undefined || row.price === ""
        ? null
        : Number(row.price),
    createdAt: row.createdAt ?? row.created_at ?? null,
  };
}

function normalizeUnitLevelApiRow(row) {
  return {
    id: toCleanText(row.id),
    code: toCleanText(row.code),
    displayName: toCleanText(row.displayName || row.display_name || row.code) || "-",
    sortOrder: Number(row.sortOrder ?? row.sort_order ?? 0),
    isBase: Boolean(row.isBase ?? row.is_base),
    isSellable: Boolean(row.isSellable ?? row.is_sellable),
    isDefault: Boolean(row.isDefault ?? row.is_default),
    isActive: Boolean(row.isActive ?? row.is_active ?? true),
    barcode: toCleanText(row.barcode),
    quantityPerBase:
      row.quantityPerBase === null || row.quantityPerBase === undefined
        ? null
        : Number(row.quantityPerBase),
    unitTypeCode: toCleanText(row.unitTypeCode ?? row.unit_type_code).toUpperCase(),
    unitTypeLabel: toCleanText(
      row.unitTypeLabel ?? row.unit_type_label ?? row.unitTypeCode ?? row.unit_type_code
    ),
  };
}

async function listActiveProductUnitLevelRows(db, productId) {
  const activePredicate = productUnitLevelsActiveCompatPredicate("pul");
  const result = await db.query(
    `
      SELECT
        pul.id,
        pul.code,
        pul.display_name AS "displayName",
        pul.sort_order AS "sortOrder",
        pul.is_base AS "isBase",
        pul.is_sellable AS "isSellable",
        ${buildProductUnitLevelsIsActiveSelect("pul")},
        pul.barcode,
        NULLIF((regexp_match(COALESCE(pul.unit_key, ''), 'qpb=([0-9]+(?:\\.[0-9]+)?)'))[1], '')::numeric AS "quantityPerBase",
        ut.code AS "unitTypeCode",
        COALESCE(NULLIF(ut.name_th, ''), NULLIF(ut.name_en, ''), NULLIF(ut.symbol, ''), ut.code, pul.code) AS "unitTypeLabel"
      FROM product_unit_levels pul
      LEFT JOIN unit_types ut ON ut.id = pul.unit_type_id
      WHERE pul.product_id = $1
        AND ${activePredicate}
      ORDER BY pul.is_sellable DESC, pul.is_base DESC, pul.sort_order ASC, pul.created_at ASC
    `,
    [productId]
  );

  return result.rows;
}

async function getStoredReportReceiveUnitSelection(db, productId) {
  const result = await db.query(
    `
      SELECT
        p.report_receive_unit_level_id::text AS "levelId",
        pul.display_name AS "displayName",
        pul.is_base AS "isBase",
        ut.code AS "unitTypeCode",
        NULLIF((regexp_match(COALESCE(pul.unit_key, ''), 'qpb=([0-9]+(?:\\.[0-9]+)?)'))[1], '')::numeric AS "quantityPerBase"
      FROM products p
      LEFT JOIN product_unit_levels pul ON pul.id = p.report_receive_unit_level_id
      LEFT JOIN unit_types ut ON ut.id = pul.unit_type_id
      WHERE p.id = $1
      LIMIT 1
    `,
    [productId]
  );

  const row = result.rows[0];
  const levelId = toCleanText(row?.levelId);
  if (!levelId) {
    return {
      hasField: false,
      levelId: null,
      selectionKey: null,
    };
  }

  return {
    hasField: true,
    levelId,
    selectionKey: toPackagingStructuralKey({
      unitTypeCode: row?.unitTypeCode,
      quantityPerBase: row?.quantityPerBase,
      displayName: row?.displayName,
      isBase: row?.isBase,
    }),
  };
}

async function setProductReportReceiveUnitLevelId(db, productId, unitLevelId) {
  await db.query(
    `
      UPDATE products
      SET report_receive_unit_level_id = $2::uuid,
          updated_at = now()
      WHERE id = $1
    `,
    [productId, unitLevelId || null]
  );
}

async function syncProductReportReceiveUnitSelection(
  db,
  productId,
  selection = { hasField: false, levelId: null, selectionKey: null },
  { fallbackToPrimary = false } = {}
) {
  const activeLevels = (await listActiveProductUnitLevelRows(db, productId)).map(normalizePackagingLevelRow);

  let matchedLevel = null;
  if (selection?.levelId) {
    matchedLevel = activeLevels.find((level) => toCleanText(level.id) === toCleanText(selection.levelId)) || null;
  }

  if (!matchedLevel && selection?.selectionKey) {
    matchedLevel =
      activeLevels.find((level) => toPackagingStructuralKey(level) === selection.selectionKey) || null;
  }

  if (!matchedLevel && selection?.hasField && (selection.levelId || selection.selectionKey)) {
    throw httpError(400, "reportReceiveUnit must match an active packaging level of the product");
  }

  if (!matchedLevel && fallbackToPrimary) {
    matchedLevel =
      activeLevels.find((level) => level.isSellable && level.isActive !== false) ||
      activeLevels.find((level) => level.isBase && level.isActive !== false) ||
      activeLevels[0] ||
      null;
  }

  await setProductReportReceiveUnitLevelId(db, productId, matchedLevel?.id || null);
  return matchedLevel;
}

async function findProductLotForUnitLevelLookup(db, productId, { lotId, lotNo, expDate }) {
  const normalizedLotId = toCleanText(lotId);
  if (normalizedLotId) {
    const result = await db.query(
      `
        SELECT id, lot_no AS "lotNo", exp_date::text AS "expDate"
        FROM product_lots
        WHERE product_id = $1
          AND id = $2::uuid
        LIMIT 1
      `,
      [productId, normalizedLotId]
    );
    return result.rows[0] || null;
  }

  const normalizedLotNo = toCleanText(lotNo);
  const normalizedExpDate = toCleanText(expDate);
  if (!normalizedLotNo || !normalizedExpDate) {
    return null;
  }

  const result = await db.query(
    `
      SELECT id, lot_no AS "lotNo", exp_date::text AS "expDate"
      FROM product_lots
      WHERE product_id = $1
        AND lot_no = $2
        AND exp_date = $3::date
      LIMIT 1
    `,
    [productId, normalizedLotNo, normalizedExpDate]
  );
  return result.rows[0] || null;
}

async function listLotAllowedUnitLevelRows(db, productId, productLotId) {
  const activePredicate = productUnitLevelsActiveCompatPredicate("pul");
  const result = await db.query(
    `
      SELECT
        plaul.id AS "mappingId",
        plaul.is_default AS "isDefault",
        pul.id,
        pul.code,
        pul.display_name AS "displayName",
        pul.sort_order AS "sortOrder",
        pul.is_base AS "isBase",
        pul.is_sellable AS "isSellable",
        ${buildProductUnitLevelsIsActiveSelect("pul")},
        pul.barcode,
        NULLIF((regexp_match(COALESCE(pul.unit_key, ''), 'qpb=([0-9]+(?:\\.[0-9]+)?)'))[1], '')::numeric AS "quantityPerBase",
        ut.code AS "unitTypeCode",
        COALESCE(NULLIF(ut.name_th, ''), NULLIF(ut.name_en, ''), NULLIF(ut.symbol, ''), ut.code, pul.code) AS "unitTypeLabel"
      FROM product_lot_allowed_unit_levels plaul
      LEFT JOIN product_unit_levels pul
        ON pul.id = plaul.unit_level_id
       AND pul.product_id = plaul.product_id
       AND ${activePredicate}
      LEFT JOIN unit_types ut ON ut.id = pul.unit_type_id
      WHERE plaul.product_id = $1
        AND plaul.product_lot_id = $2
        AND plaul.is_active = true
      ORDER BY
        plaul.is_default DESC,
        pul.is_sellable DESC NULLS LAST,
        pul.is_base DESC NULLS LAST,
        pul.sort_order ASC NULLS LAST,
        pul.created_at ASC NULLS LAST
    `,
    [productId, productLotId]
  );

  return result.rows;
}

async function listProductLotWhitelistMappings(db, productId) {
  const activePredicate = productUnitLevelsActiveCompatPredicate("pul");
  const result = await db.query(
    `
      SELECT
        plaul.id AS "mappingId",
        plaul.product_lot_id AS "productLotId",
        plaul.unit_level_id AS "unitLevelId",
        plaul.is_default AS "isDefault",
        plaul.is_active AS "isActive",
        pul.id AS "resolvedUnitLevelId"
      FROM product_lot_allowed_unit_levels plaul
      LEFT JOIN product_unit_levels pul
        ON pul.id = plaul.unit_level_id
       AND pul.product_id = plaul.product_id
       AND ${activePredicate}
      WHERE plaul.product_id = $1
        AND plaul.is_active = true
      ORDER BY plaul.created_at ASC, plaul.id ASC
    `,
    [productId]
  );

  return result.rows;
}

async function listProductLots(db, productId, { includeLatestAudit = false } = {}) {
  if (includeLatestAudit && (await hasProductLotEditAuditsTable(db))) {
    const result = await db.query(
      `
        SELECT
          pl.id,
          pl.lot_no AS "lotNo",
          pl.mfg_date::text AS "mfgDate",
          pl.exp_date::text AS "expDate",
          pl.manufacturer_name AS "manufacturerName",
          latest_audit.reason_text AS "latestEditReason",
          latest_audit.edited_at AS "latestEditedAt",
          latest_audit.edited_by_name AS "latestEditedByName",
          latest_audit.edited_by_username AS "latestEditedByUsername"
        FROM product_lots pl
        LEFT JOIN LATERAL (
          SELECT
            pla.reason_text,
            pla.edited_at,
            COALESCE(NULLIF(trim(u.full_name), ''), NULLIF(trim(u.username), ''), 'unknown') AS edited_by_name,
            u.username AS edited_by_username
          FROM product_lot_edit_audits pla
          LEFT JOIN users u ON u.id = pla.edited_by
          WHERE pla.product_lot_id = pl.id
          ORDER BY pla.edited_at DESC
          LIMIT 1
        ) latest_audit ON true
        WHERE pl.product_id = $1
        ORDER BY pl.exp_date DESC, pl.lot_no ASC
      `,
      [productId]
    );

    return result.rows;
  }

  const result = await db.query(
    `
      SELECT
        id,
        lot_no AS "lotNo",
        mfg_date::text AS "mfgDate",
        exp_date::text AS "expDate",
        manufacturer_name AS "manufacturerName",
        NULL::text AS "latestEditReason",
        NULL::timestamptz AS "latestEditedAt",
        NULL::text AS "latestEditedByName",
        NULL::text AS "latestEditedByUsername"
      FROM product_lots
      WHERE product_id = $1
      ORDER BY exp_date DESC, lot_no ASC
    `,
    [productId]
  );

  return result.rows;
}

function buildPackagingSummary(packagingLevels) {
  const activeLevels = Array.isArray(packagingLevels)
    ? packagingLevels.filter((level) => level?.isActive !== false)
    : [];
  if (!activeLevels.length) return "";
  if (activeLevels.length === 1) {
    const only = activeLevels[0];
    return only.unitTypeCode ? `${only.displayName} (${only.unitTypeCode})` : only.displayName;
  }
  return `หลายรูปแบบบรรจุ (${activeLevels.length} แบบ)`;
}

async function resolveDosageFormId(db, dosageFormCode, dosageFormNameTh) {
  const code = String(dosageFormCode || "TABLET").trim().toUpperCase();
  if (!code) throw httpError(400, "dosageFormCode is required");

  const existing = await db.query(
    `
      SELECT id
      FROM dosage_forms
      WHERE code = $1
      LIMIT 1
    `,
    [code]
  );

  if (existing.rows[0]) return existing.rows[0].id;

  const inserted = await db.query(
    `
      INSERT INTO dosage_forms (code, name_en, name_th, dosage_form_group, is_active)
      VALUES ($1, $2, $3, 'OTHER', true)
      RETURNING id
    `,
    [code, code, dosageFormNameTh || code]
  );

  return inserted.rows[0].id;
}

async function resolveUnitTypeId(db, unitCode) {
  const code = String(unitCode || "").trim().toUpperCase();
  if (!code) throw httpError(400, "unit code is required");

  const result = await db.query(
    `
      SELECT id
      FROM unit_types
      WHERE code = $1
      LIMIT 1
    `,
    [code]
  );

  if (!result.rows[0]) {
    throw httpError(400, `Unknown unit type code: ${code}`);
  }

  return result.rows[0].id;
}

async function generateUniqueIngredientCode(db, nameEn) {
  const baseCode = buildIngredientCodeBase(nameEn);
  let candidateCode = baseCode;
  let suffix = 2;

  while (true) {
    const exists = await db.query(
      `
        SELECT 1
        FROM active_ingredients
        WHERE code = $1
        LIMIT 1
      `,
      [candidateCode]
    );

    if (!exists.rows[0]) return candidateCode;

    const suffixText = `_${suffix}`;
    const prefixLength = INGREDIENT_CODE_MAX_LENGTH - suffixText.length;
    candidateCode = `${baseCode.slice(0, prefixLength)}${suffixText}`;
    suffix += 1;
  }
}

async function generateUniqueLocationCode(db, locationName) {
  const baseCode = buildLocationCodeBase(locationName);
  let candidateCode = `MFR_${baseCode}`;
  let suffix = 2;

  while (true) {
    const exists = await db.query(
      `
        SELECT 1
        FROM locations
        WHERE code = $1
        LIMIT 1
      `,
      [candidateCode]
    );

    if (!exists.rows[0]) return candidateCode;

    const suffixText = `_${suffix}`;
    const basePrefixLength = LOCATION_CODE_MAX_LENGTH - 4 - suffixText.length;
    candidateCode = `MFR_${baseCode.slice(0, basePrefixLength)}${suffixText}`;
    suffix += 1;
  }
}

async function resolveManufacturerLocationId(db, manufacturerName) {
  const name = toCleanText(manufacturerName);
  if (!name) return null;

  const existing = await db.query(
    `
      SELECT id
      FROM locations
      WHERE lower(name) = lower($1)
        AND location_type IN ('MANUFACTURER', 'VENDOR', 'WHOLESALER')
      LIMIT 1
    `,
    [name]
  );

  if (existing.rows[0]) return existing.rows[0].id;

  const code = await generateUniqueLocationCode(db, name);
  const inserted = await db.query(
    `
      INSERT INTO locations (code, name, location_type, is_active)
      VALUES ($1, $2, 'MANUFACTURER', true)
      RETURNING id
    `,
    [code, name]
  );

  return inserted.rows[0].id;
}

async function resolveDefaultPriceTierId(db) {
  const existingDefault = await db.query(
    `
      SELECT id
      FROM price_tiers
      WHERE is_default = true
        AND is_active = true
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
    `
  );

  if (existingDefault.rows[0]) return existingDefault.rows[0].id;

  const upserted = await db.query(
    `
      INSERT INTO price_tiers (code, name_en, name_th, is_default, priority, is_active)
      VALUES ('RETAIL', 'Retail', 'ราคาขายปลีก', true, 10, true)
      ON CONFLICT (code) DO UPDATE
      SET
        is_default = true,
        is_active = true
      RETURNING id
    `
  );

  return upserted.rows[0].id;
}

async function resolvePrimaryUnitLevel(db, productId) {
  const activePredicate = productUnitLevelsActiveCompatPredicate("pul");
  const result = await db.query(
    `
      SELECT
        pul.id,
        pul.display_name,
        pul.barcode,
        pul.unit_type_id,
        ut.code AS unit_type_code
      FROM product_unit_levels pul
      LEFT JOIN unit_types ut ON ut.id = pul.unit_type_id
      WHERE pul.product_id = $1
        AND ${activePredicate}
      ORDER BY pul.is_sellable DESC, pul.is_base DESC, pul.sort_order ASC, pul.created_at ASC
      LIMIT 1
    `,
    [productId]
  );

  return result.rows[0] || null;
}

async function resolveProductCodeForUnitKey(db, productId) {
  const result = await db.query(
    `
      SELECT COALESCE(NULLIF(trim(product_code), ''), id::text) AS product_code
      FROM products
      WHERE id = $1
      LIMIT 1
    `,
    [productId]
  );
  return String(result.rows[0]?.product_code || productId).trim();
}

async function generateUniquePackagingLevelCode(db, productId, displayName, unitTypeCode, quantityPerBase) {
  const baseToken =
    toCleanText(`${unitTypeCode}_${formatPackagingQuantity(quantityPerBase)}_${displayName}`)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "UNIT";
  const trimmedBase = baseToken.slice(0, PRODUCT_UNIT_LEVEL_CODE_MAX_LENGTH);
  let candidateCode = trimmedBase;
  let suffix = 2;

  while (true) {
    const exists = await db.query(
      `
        SELECT 1
        FROM product_unit_levels
        WHERE product_id = $1
          AND code = $2
        LIMIT 1
      `,
      [productId, candidateCode]
    );

    if (!exists.rows[0]) return candidateCode;

    const suffixText = `_${suffix}`;
    const prefixLength = PRODUCT_UNIT_LEVEL_CODE_MAX_LENGTH - suffixText.length;
    candidateCode = `${trimmedBase.slice(0, prefixLength)}${suffixText}`;
    suffix += 1;
  }
}

async function listProductPackagingLevels(db, productId, { includeInactive = false } = {}) {
  const params = [productId];
  const where = ["pul.product_id = $1"];
  if (!includeInactive) {
    where.push(productUnitLevelsActiveCompatPredicate("pul"));
  }

  const result = await db.query(
    `
      SELECT
        pul.id::text AS id,
        pul.code,
        pul.display_name AS "displayName",
        pul.sort_order AS "sortOrder",
        pul.is_base AS "isBase",
        pul.is_sellable AS "isSellable",
        ${buildProductUnitLevelsIsActiveSelect("pul")},
        pul.barcode,
        pul.unit_key AS "unitKey",
        pul.created_at AS "createdAt",
        NULLIF((regexp_match(COALESCE(pul.unit_key, ''), 'qpb=([0-9]+(?:\\.[0-9]+)?)'))[1], '')::numeric AS "quantityPerBase",
        ut.code AS "unitTypeCode",
        COALESCE(NULLIF(ut.name_th, ''), NULLIF(ut.name_en, ''), NULLIF(ut.symbol, ''), ut.code, pul.code) AS "unitTypeLabel",
        (
          SELECT pp.price
          FROM product_prices pp
          LEFT JOIN price_tiers pt ON pt.id = pp.price_tier_id
          WHERE pp.product_id = pul.product_id
            AND pp.unit_level_id = pul.id
            AND (pp.effective_to IS NULL OR pp.effective_to >= CURRENT_DATE)
          ORDER BY
            COALESCE(pt.is_default, false) DESC,
            pp.effective_from DESC
          LIMIT 1
        ) AS price
      FROM product_unit_levels pul
      LEFT JOIN unit_types ut ON ut.id = pul.unit_type_id
      WHERE ${where.join(" AND ")}
      ORDER BY ${productUnitLevelsIsActiveCompatExpression("pul")} DESC, pul.sort_order ASC, pul.created_at ASC
    `,
    params
  );

  return result.rows.map((row) => normalizePackagingLevelRow(row));
}

async function productHasOperationalHistory(db, productId) {
  const result = await db.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM stock_movements
        WHERE product_id = $1
        LIMIT 1
      ) OR EXISTS (
        SELECT 1
        FROM stock_on_hand
        WHERE product_id = $1
        LIMIT 1
      ) AS has_history
    `,
    [productId]
  );

  return Boolean(result.rows[0]?.has_history);
}

async function resolveNextProductUnitSortOrder(db, productId) {
  const result = await db.query(
    `
      SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort_order
      FROM product_unit_levels
      WHERE product_id = $1
    `,
    [productId]
  );
  return Number(result.rows[0]?.next_sort_order || 1);
}

async function releaseConflictingInactivePackagingBarcodes(
  db,
  productId,
  keepLevelIds,
  barcodes,
  hasIsActiveColumn
) {
  if (!hasIsActiveColumn) return;
  const normalizedBarcodes = [...new Set(barcodes.map((barcode) => toCleanText(barcode)).filter(Boolean))];
  if (!normalizedBarcodes.length) return;
  const inactivePredicate = productUnitLevelsInactiveCompatPredicate("product_unit_levels");

  if (keepLevelIds.length) {
    await db.query(
      `
        UPDATE product_unit_levels
        SET barcode = NULL
        WHERE product_id = $1
          AND ${inactivePredicate}
          AND barcode = ANY($2::text[])
          AND id::text <> ALL($3::text[])
      `,
      [productId, normalizedBarcodes, keepLevelIds]
    );
    return;
  }

  await db.query(
    `
      UPDATE product_unit_levels
      SET barcode = NULL
      WHERE product_id = $1
        AND ${inactivePredicate}
        AND barcode = ANY($2::text[])
    `,
    [productId, normalizedBarcodes]
  );
}

async function parkPackagingLevels(db, assignments) {
  for (const assignment of assignments) {
    await db.query(
      `
        UPDATE product_unit_levels
        SET sort_order = $2
        WHERE id = $1
      `,
      [assignment.id, assignment.sortOrder]
    );
  }
}

async function deactivatePackagingLevels(db, levelAssignments, hasIsActiveColumn) {
  if (!hasIsActiveColumn) return;
  for (const assignment of levelAssignments) {
    await db.query(
      `
        UPDATE product_unit_levels
        SET
          is_active = false,
          is_base = false,
          is_sellable = false,
          barcode = NULL,
          sort_order = $2
        WHERE id = $1
      `,
      [assignment.id, assignment.sortOrder]
    );
  }
}

async function syncProductUnitConversions(db, productId, packagingLevels) {
  await db.query(
    `
      DELETE FROM product_unit_conversions
      WHERE product_id = $1
    `,
    [productId]
  );

  const baseLevel = packagingLevels.find((level) => level.isBase && level.isActive !== false);
  if (!baseLevel) return;

  for (const level of packagingLevels) {
    if (!level.id || level.isBase || level.isActive === false) continue;
    await db.query(
      `
        INSERT INTO product_unit_conversions (
          product_id,
          parent_unit_level_id,
          child_unit_level_id,
          multiplier
        )
        VALUES ($1, $2, $3, $4)
      `,
      [productId, level.id, baseLevel.id, level.quantityPerBase]
    );
  }
}

async function upsertDefaultPrice(db, productId, unitLevelId, price) {
  const priceTierId = await resolveDefaultPriceTierId(db);
  await db.query(
    `
      INSERT INTO product_prices (
        product_id,
        unit_level_id,
        price_tier_id,
        price,
        currency_code,
        effective_from,
        effective_to
      )
      VALUES ($1, $2, $3, $4, 'THB', CURRENT_DATE, NULL)
      ON CONFLICT (product_id, unit_level_id, price_tier_id, effective_from)
      DO UPDATE
      SET
        price = EXCLUDED.price,
        effective_to = NULL
    `,
    [productId, unitLevelId, priceTierId, price]
  );
}

async function syncPackagingLevelsAndPrice(db, productId, packagingLevels, price) {
  const hasIsActiveColumn = await hasProductUnitLevelsIsActiveColumn(db);
  const existingLevels = await listProductPackagingLevels(db, productId, {
    includeInactive: true,
  });
  const existingById = new Map(existingLevels.map((level) => [level.id, level]));
  const existingByStructuralKey = new Map();

  for (const level of existingLevels) {
    const structuralKey = toPackagingStructuralKey(level);
    if (!existingByStructuralKey.has(structuralKey)) {
      existingByStructuralKey.set(structuralKey, []);
    }
    existingByStructuralKey.get(structuralKey).push(level);
  }

  const currentBaseLevel = existingLevels.find((level) => level.isActive && level.isBase);
  const nextBaseLevel = packagingLevels.find((level) => level.isBase);
  if (
    currentBaseLevel &&
    nextBaseLevel &&
    toPackagingStructuralKey(currentBaseLevel) !== toPackagingStructuralKey(nextBaseLevel) &&
    (await productHasOperationalHistory(db, productId))
  ) {
    throw httpError(
      400,
      "Cannot change the base packaging level for a product that already has stock or movement history"
    );
  }

  const usedExistingIds = new Set();
  const idsToDeactivate = new Set();
  const selectedLevels = [];
  let nextParkingSortOrder =
    Math.max(
      packagingLevels.length,
      ...existingLevels.map((level) => Number(level.sortOrder || 0))
    ) + 100;

  for (const incomingLevel of packagingLevels) {
    const structuralKey = toPackagingStructuralKey(incomingLevel);
    const exactMatch = incomingLevel.id ? existingById.get(incomingLevel.id) || null : null;
    let targetLevel =
      exactMatch && toPackagingStructuralKey(exactMatch) === structuralKey ? exactMatch : null;

    if (!targetLevel) {
      const candidates = existingByStructuralKey.get(structuralKey) || [];
      targetLevel = candidates.find((candidate) => !usedExistingIds.has(candidate.id)) || null;
    }

    if (exactMatch && targetLevel && exactMatch.id !== targetLevel.id) {
      idsToDeactivate.add(exactMatch.id);
    }

    if (targetLevel) {
      usedExistingIds.add(targetLevel.id);
      selectedLevels.push({
        mode: "update",
        input: incomingLevel,
        target: targetLevel,
      });
      continue;
    }

    selectedLevels.push({
      mode: "insert",
      input: incomingLevel,
      target: null,
    });
  }

  for (const existingLevel of existingLevels) {
    if (existingLevel.isActive && !usedExistingIds.has(existingLevel.id)) {
      idsToDeactivate.add(existingLevel.id);
    }
  }

  if (!hasIsActiveColumn && idsToDeactivate.size) {
    throw httpError(
      409,
      "Retiring or replacing packaging levels requires migration 0016_product_unit_levels_is_active.sql"
    );
  }

  const parkingAssignments = [
    ...existingLevels
      .filter((level) => !level.isActive && !usedExistingIds.has(level.id))
      .map((level) => ({
        id: level.id,
        sortOrder: nextParkingSortOrder++,
      })),
    ...selectedLevels
      .filter(
        (selectedLevel) =>
          selectedLevel.mode === "update" &&
          selectedLevel.target &&
          Number(selectedLevel.target.sortOrder || 0) !== Number(selectedLevel.input.sortOrder || 0)
      )
      .map((selectedLevel) => ({
        id: selectedLevel.target.id,
        sortOrder: nextParkingSortOrder++,
      })),
  ];

  await parkPackagingLevels(db, parkingAssignments);
  const barcodeParkingIds = selectedLevels
    .filter(
      (selectedLevel) =>
        selectedLevel.mode === "update" &&
        selectedLevel.target &&
        toCleanText(selectedLevel.target.barcode) &&
        toCleanText(selectedLevel.target.barcode) !== toCleanText(selectedLevel.input.barcode)
    )
    .map((selectedLevel) => selectedLevel.target.id);
  if (barcodeParkingIds.length) {
    await db.query(
      `
        UPDATE product_unit_levels
        SET barcode = NULL
        WHERE id::text = ANY($1::text[])
      `,
      [barcodeParkingIds]
    );
  }
  await deactivatePackagingLevels(
    db,
    [...idsToDeactivate].map((id) => ({
      id,
      sortOrder: nextParkingSortOrder++,
    })),
    hasIsActiveColumn
  );
  await releaseConflictingInactivePackagingBarcodes(
    db,
    productId,
    [...usedExistingIds],
    packagingLevels.map((level) => level.barcode),
    hasIsActiveColumn
  );

  const productCodeForKey = await resolveProductCodeForUnitKey(db, productId);
  const baseSortOrder = nextBaseLevel?.sortOrder || 1;
  const baseUnitCode = nextBaseLevel?.unitTypeCode || "UNIT";
  const persistedLevels = [];

  for (const selectedLevel of selectedLevels) {
    const { input } = selectedLevel;
    const unitTypeId = await resolveUnitTypeId(db, input.unitTypeCode);
    const nextUnitKey = buildUnitLevelKey({
      productCode: productCodeForKey,
      level: input.sortOrder,
      parentLevel: input.isBase ? 0 : baseSortOrder,
      quantityPerParentUnit: input.isBase ? 1 : input.quantityPerBase,
      quantityPerBaseUnit: input.quantityPerBase,
      baseUnitCode,
      unitTypeCode: input.unitTypeCode,
    });

    if (selectedLevel.mode === "update" && selectedLevel.target) {
      const updated = await db.query(
        `
          UPDATE product_unit_levels
          SET
            display_name = $2,
            unit_type_id = $3,
            is_base = $4,
            is_sellable = $5,
            sort_order = $6,
            barcode = $7,
            unit_key = $8${hasIsActiveColumn ? `,
            is_active = true` : ""}
          WHERE id = $1
          RETURNING
            id::text AS id,
            code,
            display_name AS "displayName",
            sort_order AS "sortOrder",
            is_base AS "isBase",
            is_sellable AS "isSellable",
            barcode,
            unit_key AS "unitKey"
        `,
        [
          selectedLevel.target.id,
          input.displayName,
          unitTypeId,
          input.isBase,
          input.isSellable,
          input.sortOrder,
          input.barcode,
          nextUnitKey,
        ]
      );

      persistedLevels.push(
        normalizePackagingLevelRow({
          ...updated.rows[0],
          isActive: true,
          quantityPerBase: input.quantityPerBase,
          unitTypeCode: input.unitTypeCode,
        })
      );
      continue;
    }

    const code = await generateUniquePackagingLevelCode(
      db,
      productId,
      input.displayName,
      input.unitTypeCode,
      input.quantityPerBase
    );
    const inserted = await db.query(
      `
        INSERT INTO product_unit_levels (
          product_id,
          code,
          display_name,
          unit_type_id,
          unit_key,
          is_base,
          is_sellable,
          sort_order,
          barcode${hasIsActiveColumn ? `,
          is_active` : ""}
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9${hasIsActiveColumn ? ", true" : ""})
        RETURNING
          id::text AS id,
          code,
          display_name AS "displayName",
          sort_order AS "sortOrder",
          is_base AS "isBase",
          is_sellable AS "isSellable",
          barcode,
          unit_key AS "unitKey"
      `,
      [
        productId,
        code,
        input.displayName,
        unitTypeId,
        nextUnitKey,
        input.isBase,
        input.isSellable,
        input.sortOrder,
        input.barcode,
      ]
    );

    persistedLevels.push(
      normalizePackagingLevelRow({
        ...inserted.rows[0],
        isActive: true,
        quantityPerBase: input.quantityPerBase,
        unitTypeCode: input.unitTypeCode,
      })
    );
  }

  await syncProductUnitConversions(db, productId, persistedLevels);

  if (price !== null) {
    const sellableLevel = persistedLevels.find((level) => level.isSellable);
    if (!sellableLevel) {
      throw httpError(400, "A sellable packaging level is required before saving price");
    }
    await upsertDefaultPrice(db, productId, sellableLevel.id, price);
  }
}

async function upsertPrimaryUnitLevelAndPrice(db, productId, options) {
  const shouldUpsertUnit = options.shouldUpsertUnit;
  if (!shouldUpsertUnit && options.price === null) return;

  const hasIsActiveColumn = await hasProductUnitLevelsIsActiveColumn(db);
  let unitLevel = await resolvePrimaryUnitLevel(db, productId);

  if (shouldUpsertUnit) {
    const unitTypeCode = options.unitTypeCode || unitLevel?.unit_type_code || "TABLET";
    const unitTypeId = await resolveUnitTypeId(db, unitTypeCode);
    const productCodeForKey = await resolveProductCodeForUnitKey(db, productId);
    const fallbackUnitKey = buildUnitLevelKey({
      productCode: productCodeForKey,
      level: 1,
      parentLevel: 0,
      quantityPerParentUnit: 1,
      quantityPerBaseUnit: 1,
      baseUnitCode: unitTypeCode,
      unitTypeCode,
    });
    const nextDisplayName =
      options.packageSize || unitLevel?.display_name || "หน่วยขายมาตรฐาน";
    const nextBarcode =
      options.barcode !== undefined
        ? options.barcode || null
        : unitLevel?.barcode || null;

    if (unitLevel) {
      const updated = await db.query(
        `
          UPDATE product_unit_levels
          SET
            display_name = $2,
            unit_type_id = $3,
            barcode = $4,
            unit_key = COALESCE(unit_key, $5),
            is_sellable = true${hasIsActiveColumn ? `,
            is_active = true` : ""}
          WHERE id = $1
          RETURNING
            id,
            display_name,
            barcode,
            unit_type_id,
            unit_key
        `,
        [unitLevel.id, nextDisplayName, unitTypeId, nextBarcode, fallbackUnitKey]
      );
      unitLevel = {
        ...unitLevel,
        id: updated.rows[0].id,
        display_name: updated.rows[0].display_name,
        barcode: updated.rows[0].barcode,
        unit_type_id: updated.rows[0].unit_type_id,
        unit_type_code: unitTypeCode,
      };
    } else {
      const nextSortOrder = await resolveNextProductUnitSortOrder(db, productId);
      const inserted = await db.query(
        `
          INSERT INTO product_unit_levels (
            product_id,
            code,
            display_name,
            unit_type_id,
            unit_key,
            is_base,
            is_sellable,
            sort_order,
            barcode${hasIsActiveColumn ? `,
            is_active` : ""}
          )
          VALUES ($1, $2, $3, $4, $5, true, true, $6, $7${hasIsActiveColumn ? ", true" : ""})
          RETURNING id
        `,
        [
          productId,
          UNIT_LEVEL_DEFAULT_CODE,
          nextDisplayName,
          unitTypeId,
          fallbackUnitKey,
          nextSortOrder,
          nextBarcode,
        ]
      );
      unitLevel = {
        id: inserted.rows[0].id,
        display_name: nextDisplayName,
        barcode: nextBarcode,
        unit_type_id: unitTypeId,
        unit_type_code: unitTypeCode,
      };
    }
  }

  if (options.price !== null) {
    if (!unitLevel) {
      throw httpError(400, "unit level is required before saving price");
    }
    await upsertDefaultPrice(db, productId, unitLevel.id, options.price);
  }
}

async function resolveActiveIngredientId(db, ingredient) {
  if (ingredient.activeIngredientId) {
    const existingById = await db.query(
      `
        SELECT
          id,
          code,
          name_en,
          name_th
        FROM active_ingredients
        WHERE id::text = $1
        LIMIT 1
      `,
      [ingredient.activeIngredientId]
    );

    if (!existingById.rows[0]) {
      throw httpError(400, `Unknown activeIngredientId: ${ingredient.activeIngredientId}`);
    }

    ingredient.activeIngredientCode = ingredient.activeIngredientCode || existingById.rows[0].code;
    ingredient.nameEn = ingredient.nameEn || existingById.rows[0].name_en;
    ingredient.nameTh = ingredient.nameTh || existingById.rows[0].name_th || null;
    return existingById.rows[0].id;
  }

  if (ingredient.activeIngredientCode) {
    const existing = await db.query(
      `
        SELECT id
        FROM active_ingredients
        WHERE code = $1
        LIMIT 1
      `,
      [ingredient.activeIngredientCode]
    );

    if (existing.rows[0]) return existing.rows[0].id;

    const inserted = await db.query(
      `
        INSERT INTO active_ingredients (code, name_en, name_th, is_active)
        VALUES ($1, $2, $3, true)
        RETURNING id
      `,
      [ingredient.activeIngredientCode, ingredient.nameEn, ingredient.nameTh]
    );

    return inserted.rows[0].id;
  }

  const byName = await db.query(
    `
      SELECT id
      FROM active_ingredients
      WHERE lower(name_en) = lower($1)
      LIMIT 1
    `,
    [ingredient.nameEn]
  );

  if (byName.rows[0]) return byName.rows[0].id;

  const generatedCode = await generateUniqueIngredientCode(db, ingredient.nameEn);
  const inserted = await db.query(
    `
      INSERT INTO active_ingredients (code, name_en, name_th, is_active)
      VALUES ($1, $2, $3, true)
      RETURNING id
    `,
    [generatedCode, ingredient.nameEn, ingredient.nameTh]
  );

  return inserted.rows[0].id;
}

async function syncProductIngredients(db, productId, ingredients) {
  await db.query(
    `
      DELETE FROM product_ingredients
      WHERE product_id = $1
    `,
    [productId]
  );

  if (!ingredients.length) return;

  const unitTypeIdCache = new Map();

  async function resolveUnitTypeIdCached(unitCode) {
    const key = String(unitCode || "").trim().toUpperCase();
    if (unitTypeIdCache.has(key)) {
      return unitTypeIdCache.get(key);
    }
    const id = await resolveUnitTypeId(db, key);
    unitTypeIdCache.set(key, id);
    return id;
  }

  for (let index = 0; index < ingredients.length; index += 1) {
    const ingredient = ingredients[index];
    const activeIngredientId = await resolveActiveIngredientId(db, ingredient);
    const numeratorUnitId = await resolveUnitTypeIdCached(ingredient.numeratorUnitCode);
    const denominatorUnitId = ingredient.denominatorUnitCode
      ? await resolveUnitTypeIdCached(ingredient.denominatorUnitCode)
      : null;

    await db.query(
      `
        INSERT INTO product_ingredients (
          product_id,
          active_ingredient_id,
          strength_numerator,
          numerator_unit_id,
          strength_denominator,
          denominator_unit_id,
          sort_order
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        productId,
        activeIngredientId,
        ingredient.strengthNumerator,
        numeratorUnitId,
        ingredient.strengthDenominator,
        denominatorUnitId,
        index + 1,
      ]
    );
  }
}

async function resolveReportGroupsByCodes(db, reportGroupCodes) {
  if (!reportGroupCodes.length) return [];

  const result = await db.query(
    `
      SELECT id, code
      FROM report_groups
      WHERE code = ANY($1::text[])
    `,
    [reportGroupCodes]
  );

  const foundByCode = new Map(result.rows.map((row) => [row.code, row.id]));
  const missingCodes = reportGroupCodes.filter((code) => !foundByCode.has(code));
  if (missingCodes.length) {
    throw httpError(400, `Unknown report group code(s): ${missingCodes.join(", ")}`);
  }

  return reportGroupCodes.map((code) => ({ code, id: foundByCode.get(code) }));
}

async function syncProductReportGroups(db, productId, reportGroupCodes) {
  const resolvedGroups = await resolveReportGroupsByCodes(db, reportGroupCodes);
  const targetCodes = new Set(resolvedGroups.map((group) => group.code));

  const existingActive = await db.query(
    `
      SELECT
        prg.id,
        prg.report_group_id,
        rg.code
      FROM product_report_groups prg
      JOIN report_groups rg ON rg.id = prg.report_group_id
      WHERE prg.product_id = $1
        AND prg.effective_from <= CURRENT_DATE
        AND (prg.effective_to IS NULL OR prg.effective_to > CURRENT_DATE)
    `,
    [productId]
  );

  const existingByCode = new Map(existingActive.rows.map((row) => [row.code, row]));

  for (const row of existingActive.rows) {
    if (!targetCodes.has(row.code)) {
      await db.query(
        `
          UPDATE product_report_groups
          SET effective_to = CURRENT_DATE
          WHERE id = $1
            AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
        `,
        [row.id]
      );
    }
  }

  for (const group of resolvedGroups) {
    if (existingByCode.has(group.code)) continue;
    await db.query(
      `
        INSERT INTO product_report_groups (
          product_id,
          report_group_id,
          effective_from,
          effective_to
        )
        VALUES ($1, $2, CURRENT_DATE, NULL)
        ON CONFLICT (product_id, report_group_id, effective_from)
        DO UPDATE
        SET effective_to = NULL
      `,
      [productId, group.id]
    );
  }
}

function mapProductRow(row) {
  const packagingLevels = Array.isArray(row.packagingLevels)
    ? row.packagingLevels.map((level) => normalizePackagingLevelRow(level))
    : [];
  const packagingSummary = buildPackagingSummary(packagingLevels);
  const primaryPackagingLevel =
    packagingLevels.find((level) => level.isSellable && level.isActive !== false) ||
    packagingLevels.find((level) => level.isBase && level.isActive !== false) ||
    packagingLevels[0] ||
    null;
  const mappedReportReceiveUnitLevelId = toCleanText(row.reportReceiveUnitLevelId);
  const mappedReportReceivePackagingLevel =
    packagingLevels.find((level) => toCleanText(level.id) === mappedReportReceiveUnitLevelId) || null;
  const effectiveReportReceiveUnit =
    mappedReportReceivePackagingLevel ||
    (row.reportReceiveUnitLabel
      ? {
          id: mappedReportReceiveUnitLevelId,
          displayName: row.reportReceiveUnitLabel,
          quantityPerBase: row.reportReceiveUnitQuantityPerBase,
          unitTypeCode: row.reportReceiveUnitTypeCode,
          isBase: row.reportReceiveUnitIsBase,
        }
      : primaryPackagingLevel);
  const effectiveReportReceiveUnitLabel =
    toCleanText(effectiveReportReceiveUnit?.displayName) || primaryPackagingLevel?.displayName || null;

  return {
    ...row,
    ingredients: Array.isArray(row.ingredients) ? row.ingredients : [],
    reportGroupCodes: Array.isArray(row.reportGroupCodes) ? row.reportGroupCodes : [],
    reportGroupNames: Array.isArray(row.reportGroupNames) ? row.reportGroupNames : [],
    price: row.price === null || row.price === undefined ? null : Number(row.price),
    packagingLevels,
    packagingSummary,
    packageVariantCount: packagingLevels.filter((level) => level.isActive !== false).length,
    packageSize: row.packageSize || primaryPackagingLevel?.displayName || null,
    unitTypeCode: row.unitTypeCode || primaryPackagingLevel?.unitTypeCode || null,
    barcode: row.barcode || primaryPackagingLevel?.barcode || null,
    reportReceiveUnitLevelId: mappedReportReceiveUnitLevelId || null,
    reportReceiveUnitLabel: effectiveReportReceiveUnitLabel,
    reportReceiveUnitShortLabel:
      extractPackagingContainerLabel(effectiveReportReceiveUnitLabel) || effectiveReportReceiveUnitLabel,
    reportReceiveUnitKey: effectiveReportReceiveUnit
      ? toPackagingStructuralKey(effectiveReportReceiveUnit)
      : "",
  };
}

async function getProductById(productId) {
  const activeExpression = productUnitLevelsIsActiveCompatExpression("pul");
  const activePredicate = productUnitLevelsActiveCompatPredicate("pul");
  const result = await query(
    `
      SELECT
        p.id,
        p.product_code AS "productCode",
        p.trade_name AS "tradeName",
        COALESCE(ing.generic_composition, p.generic_name) AS "genericName",
        COALESCE(ing.ingredients, '[]'::json) AS ingredients,
        pu.barcode AS barcode,
        pu.package_size AS "packageSize",
        pu.unit_type_code AS "unitTypeCode",
        pu.unit_symbol AS "unitSymbol",
        pu.price AS price,
        COALESCE(pkg.packaging_levels, '[]'::json) AS "packagingLevels",
        COALESCE(pr.report_group_codes, ARRAY[]::text[]) AS "reportGroupCodes",
        COALESCE(pr.report_group_names, ARRAY[]::text[]) AS "reportGroupNames",
        rru.id AS "reportReceiveUnitLevelId",
        rru.label AS "reportReceiveUnitLabel",
        rru."quantityPerBase" AS "reportReceiveUnitQuantityPerBase",
        rru."unitTypeCode" AS "reportReceiveUnitTypeCode",
        rru."isBase" AS "reportReceiveUnitIsBase",
        mloc.name AS "manufacturerName",
        df.code AS "dosageFormCode",
        p.note_text AS "noteText",
        p.is_active AS "isActive",
        p.created_at AS "createdAt",
        p.updated_at AS "updatedAt"
      FROM products p
      JOIN dosage_forms df ON df.id = p.dosage_form_id
      LEFT JOIN locations mloc ON mloc.id = p.manufacturer_location_id
      LEFT JOIN LATERAL (
        SELECT
          string_agg(ai.name_en, ' + ' ORDER BY pi.sort_order) AS generic_composition,
          json_agg(
            json_build_object(
              'ingredientId', ai.id,
              'activeIngredientId', ai.id,
              'activeIngredientCode', ai.code,
              'nameEn', ai.name_en,
              'nameTh', ai.name_th,
              'strengthNumerator', pi.strength_numerator,
              'numeratorUnitCode', nu.code,
              'numeratorUnitSymbol', nu.symbol,
              'strengthDenominator', pi.strength_denominator,
              'denominatorUnitCode', du.code,
              'denominatorUnitSymbol', du.symbol,
              'sortOrder', pi.sort_order
            )
            ORDER BY pi.sort_order
          ) AS ingredients
        FROM product_ingredients pi
        JOIN active_ingredients ai ON ai.id = pi.active_ingredient_id
        JOIN unit_types nu ON nu.id = pi.numerator_unit_id
        LEFT JOIN unit_types du ON du.id = pi.denominator_unit_id
        WHERE pi.product_id = p.id
      ) ing ON true
      LEFT JOIN LATERAL (
        SELECT
          json_agg(
            json_build_object(
              'id', pul.id,
              'code', pul.code,
              'displayName', pul.display_name,
              'sortOrder', pul.sort_order,
              'isBase', pul.is_base,
              'isSellable', pul.is_sellable,
              'isActive', ${activeExpression},
              'barcode', pul.barcode,
              'quantityPerBase', NULLIF((regexp_match(COALESCE(pul.unit_key, ''), 'qpb=([0-9]+(?:\\.[0-9]+)?)'))[1], '')::numeric,
              'unitTypeCode', ut.code,
              'unitTypeLabel', COALESCE(NULLIF(ut.name_th, ''), NULLIF(ut.name_en, ''), NULLIF(ut.symbol, ''), ut.code, pul.code)
            )
            ORDER BY pul.is_sellable DESC, pul.is_base DESC, pul.sort_order ASC, pul.created_at ASC
          ) AS packaging_levels
        FROM product_unit_levels pul
        LEFT JOIN unit_types ut ON ut.id = pul.unit_type_id
        WHERE pul.product_id = p.id
          AND ${activePredicate}
      ) pkg ON true
      LEFT JOIN LATERAL (
        SELECT
          pul.id::text AS id,
          pul.display_name AS label,
          NULLIF((regexp_match(COALESCE(pul.unit_key, ''), 'qpb=([0-9]+(?:\\.[0-9]+)?)'))[1], '')::numeric AS "quantityPerBase",
          ut.code AS "unitTypeCode",
          pul.is_base AS "isBase"
        FROM product_unit_levels pul
        LEFT JOIN unit_types ut ON ut.id = pul.unit_type_id
        WHERE pul.id = p.report_receive_unit_level_id
        LIMIT 1
      ) rru ON true
      LEFT JOIN LATERAL (
        SELECT
          pul.barcode,
          pul.display_name AS package_size,
          ut.code AS unit_type_code,
          ut.symbol AS unit_symbol,
          (
            SELECT pp.price
            FROM product_prices pp
            LEFT JOIN price_tiers pt ON pt.id = pp.price_tier_id
            WHERE pp.product_id = p.id
              AND pp.unit_level_id = pul.id
              AND (pp.effective_to IS NULL OR pp.effective_to >= CURRENT_DATE)
            ORDER BY
              COALESCE(pt.is_default, false) DESC,
              pp.effective_from DESC
            LIMIT 1
          ) AS price
        FROM product_unit_levels pul
        LEFT JOIN unit_types ut ON ut.id = pul.unit_type_id
        WHERE pul.product_id = p.id
          AND ${activePredicate}
        ORDER BY pul.is_sellable DESC, pul.is_base DESC, pul.sort_order ASC, pul.created_at ASC
        LIMIT 1
      ) pu ON true
      LEFT JOIN LATERAL (
        SELECT
          array_agg(rg.code ORDER BY rg.code) AS report_group_codes,
          array_agg(rg.thai_name ORDER BY rg.code) AS report_group_names
        FROM product_report_groups prg
        JOIN report_groups rg ON rg.id = prg.report_group_id
        WHERE prg.product_id = p.id
          AND prg.effective_from <= CURRENT_DATE
          AND (prg.effective_to IS NULL OR prg.effective_to > CURRENT_DATE)
      ) pr ON true
      WHERE p.id = $1
      LIMIT 1
    `,
    [productId]
  );

  if (!result.rows[0]) return null;
  return mapProductRow(result.rows[0]);
}

export async function listProducts(req, res) {
  const search = String(req.query.search || "").trim();
  const includeInactive = parseBoolean(req.query.includeInactive, false);
  const barcode = String(req.query.barcode || "").trim();
  const activeExpression = productUnitLevelsIsActiveCompatExpression("pul");
  const activePredicate = productUnitLevelsActiveCompatPredicate("pul");
  const searchActivePredicate = productUnitLevelsActiveCompatPredicate("pul_search");

  if (barcode) {
    const result = await query(
      `
        SELECT
          p.id AS product_id,
          pul.barcode,
          p.product_code,
          p.trade_name,
          COALESCE(pp.price, 0) AS price,
          ut.symbol AS unit_symbol,
          COALESCE(pr.report_group_codes, ARRAY[]::text[]) AS report_group_codes
        FROM product_unit_levels pul
        JOIN products p ON p.id = pul.product_id
        LEFT JOIN unit_types ut ON ut.id = pul.unit_type_id
        LEFT JOIN LATERAL (
          SELECT array_agg(rg.code ORDER BY rg.code) AS report_group_codes
          FROM product_report_groups prg
          JOIN report_groups rg ON rg.id = prg.report_group_id
          WHERE prg.product_id = p.id
            AND prg.effective_from <= CURRENT_DATE
            AND (prg.effective_to IS NULL OR prg.effective_to > CURRENT_DATE)
        ) pr ON true
        LEFT JOIN LATERAL (
          SELECT pp.price
          FROM product_prices pp
          LEFT JOIN price_tiers pt ON pt.id = pp.price_tier_id
          WHERE pp.product_id = p.id
            AND pp.unit_level_id = pul.id
            AND (pp.effective_to IS NULL OR pp.effective_to >= CURRENT_DATE)
          ORDER BY
            COALESCE(pt.is_default, false) DESC,
            pp.effective_from DESC
          LIMIT 1
        ) pp ON true
        WHERE pul.barcode = $1
          AND ${activePredicate}
          AND p.is_active = true
        LIMIT 1
      `,
      [barcode]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Product not found for barcode" });
    }

    return res.json({
      id: result.rows[0].product_id,
      barcode: result.rows[0].barcode,
      product_code: result.rows[0].product_code,
      product_name: result.rows[0].trade_name,
      price_baht: Number(result.rows[0].price || 0),
      qty_per_unit: 1,
      unit: result.rows[0].unit_symbol || "",
      reportGroupCodes: Array.isArray(result.rows[0].report_group_codes)
        ? result.rows[0].report_group_codes
        : [],
    });
  }

  const pattern = `%${search}%`;
  const result = await query(
    `
      SELECT
        p.id,
        p.product_code AS "productCode",
        p.trade_name AS "tradeName",
        COALESCE(ing.generic_composition, p.generic_name) AS "genericName",
        COALESCE(ing.ingredients, '[]'::json) AS ingredients,
        pu.barcode AS barcode,
        pu.package_size AS "packageSize",
        pu.unit_type_code AS "unitTypeCode",
        pu.unit_symbol AS "unitSymbol",
        pu.price AS price,
        COALESCE(pkg.packaging_levels, '[]'::json) AS "packagingLevels",
        COALESCE(pr.report_group_codes, ARRAY[]::text[]) AS "reportGroupCodes",
        COALESCE(pr.report_group_names, ARRAY[]::text[]) AS "reportGroupNames",
        rru.id AS "reportReceiveUnitLevelId",
        rru.label AS "reportReceiveUnitLabel",
        rru."quantityPerBase" AS "reportReceiveUnitQuantityPerBase",
        rru."unitTypeCode" AS "reportReceiveUnitTypeCode",
        rru."isBase" AS "reportReceiveUnitIsBase",
        mloc.name AS "manufacturerName",
        df.code AS "dosageFormCode",
        p.note_text AS "noteText",
        p.is_active AS "isActive",
        p.created_at AS "createdAt",
        p.updated_at AS "updatedAt"
      FROM products p
      JOIN dosage_forms df ON df.id = p.dosage_form_id
      LEFT JOIN locations mloc ON mloc.id = p.manufacturer_location_id
      LEFT JOIN LATERAL (
        SELECT
          string_agg(ai.name_en, ' + ' ORDER BY pi.sort_order) AS generic_composition,
          json_agg(
            json_build_object(
              'ingredientId', ai.id,
              'activeIngredientId', ai.id,
              'activeIngredientCode', ai.code,
              'nameEn', ai.name_en,
              'nameTh', ai.name_th,
              'strengthNumerator', pi.strength_numerator,
              'numeratorUnitCode', nu.code,
              'numeratorUnitSymbol', nu.symbol,
              'strengthDenominator', pi.strength_denominator,
              'denominatorUnitCode', du.code,
              'denominatorUnitSymbol', du.symbol,
              'sortOrder', pi.sort_order
            )
            ORDER BY pi.sort_order
          ) AS ingredients
        FROM product_ingredients pi
        JOIN active_ingredients ai ON ai.id = pi.active_ingredient_id
        JOIN unit_types nu ON nu.id = pi.numerator_unit_id
        LEFT JOIN unit_types du ON du.id = pi.denominator_unit_id
        WHERE pi.product_id = p.id
      ) ing ON true
      LEFT JOIN LATERAL (
        SELECT
          json_agg(
            json_build_object(
              'id', pul.id,
              'code', pul.code,
              'displayName', pul.display_name,
              'sortOrder', pul.sort_order,
              'isBase', pul.is_base,
              'isSellable', pul.is_sellable,
              'isActive', ${activeExpression},
              'barcode', pul.barcode,
              'quantityPerBase', NULLIF((regexp_match(COALESCE(pul.unit_key, ''), 'qpb=([0-9]+(?:\\.[0-9]+)?)'))[1], '')::numeric,
              'unitTypeCode', ut.code,
              'unitTypeLabel', COALESCE(NULLIF(ut.name_th, ''), NULLIF(ut.name_en, ''), NULLIF(ut.symbol, ''), ut.code, pul.code)
            )
            ORDER BY pul.is_sellable DESC, pul.is_base DESC, pul.sort_order ASC, pul.created_at ASC
          ) AS packaging_levels
        FROM product_unit_levels pul
        LEFT JOIN unit_types ut ON ut.id = pul.unit_type_id
        WHERE pul.product_id = p.id
          AND ${activePredicate}
      ) pkg ON true
      LEFT JOIN LATERAL (
        SELECT
          pul.id::text AS id,
          pul.display_name AS label,
          NULLIF((regexp_match(COALESCE(pul.unit_key, ''), 'qpb=([0-9]+(?:\\.[0-9]+)?)'))[1], '')::numeric AS "quantityPerBase",
          ut.code AS "unitTypeCode",
          pul.is_base AS "isBase"
        FROM product_unit_levels pul
        LEFT JOIN unit_types ut ON ut.id = pul.unit_type_id
        WHERE pul.id = p.report_receive_unit_level_id
        LIMIT 1
      ) rru ON true
      LEFT JOIN LATERAL (
        SELECT
          pul.barcode,
          pul.display_name AS package_size,
          ut.code AS unit_type_code,
          ut.symbol AS unit_symbol,
          (
            SELECT pp.price
            FROM product_prices pp
            LEFT JOIN price_tiers pt ON pt.id = pp.price_tier_id
            WHERE pp.product_id = p.id
              AND pp.unit_level_id = pul.id
              AND (pp.effective_to IS NULL OR pp.effective_to >= CURRENT_DATE)
            ORDER BY
              COALESCE(pt.is_default, false) DESC,
              pp.effective_from DESC
            LIMIT 1
          ) AS price
        FROM product_unit_levels pul
        LEFT JOIN unit_types ut ON ut.id = pul.unit_type_id
        WHERE pul.product_id = p.id
          AND ${activePredicate}
        ORDER BY pul.is_sellable DESC, pul.is_base DESC, pul.sort_order ASC, pul.created_at ASC
        LIMIT 1
      ) pu ON true
      LEFT JOIN LATERAL (
        SELECT
          array_agg(rg.code ORDER BY rg.code) AS report_group_codes,
          array_agg(rg.thai_name ORDER BY rg.code) AS report_group_names
        FROM product_report_groups prg
        JOIN report_groups rg ON rg.id = prg.report_group_id
        WHERE prg.product_id = p.id
          AND prg.effective_from <= CURRENT_DATE
          AND (prg.effective_to IS NULL OR prg.effective_to > CURRENT_DATE)
      ) pr ON true
      WHERE (
        $1::text = ''
        OR p.trade_name ILIKE $2
        OR COALESCE(p.generic_name, '') ILIKE $2
        OR COALESCE(p.product_code, '') ILIKE $2
        OR COALESCE(pu.barcode, '') ILIKE $2
        OR COALESCE(pu.package_size, '') ILIKE $2
        OR EXISTS (
          SELECT 1
          FROM product_unit_levels pul_search
          WHERE pul_search.product_id = p.id
            AND ${searchActivePredicate}
            AND (
              COALESCE(pul_search.barcode, '') ILIKE $2
              OR COALESCE(pul_search.display_name, '') ILIKE $2
            )
        )
        OR COALESCE(mloc.name, '') ILIKE $2
        OR EXISTS (
          SELECT 1
          FROM unnest(COALESCE(pr.report_group_codes, ARRAY[]::text[])) AS rg_code
          WHERE rg_code ILIKE $2
        )
        OR EXISTS (
          SELECT 1
          FROM product_ingredients spi
          JOIN active_ingredients sai ON sai.id = spi.active_ingredient_id
          WHERE spi.product_id = p.id
            AND (
              sai.name_en ILIKE $2
              OR COALESCE(sai.name_th, '') ILIKE $2
              OR sai.code ILIKE $2
            )
        )
      )
        AND ($3::boolean = true OR p.is_active = true)
      ORDER BY p.updated_at DESC, p.trade_name ASC
      LIMIT 500
    `,
    [search, pattern, includeInactive]
  );

  return res.json(result.rows.map(mapProductRow));
}

export async function getProductUnitLevels(req, res) {
  const productId = toCleanText(req.params.id || req.params.productId);
  if (!productId || !isUuid(productId)) {
    throw httpError(400, "product id must be a valid UUID");
  }

  const lotId = toCleanText(req.query.lotId || req.query.lot_id);
  const lotNo = toCleanText(req.query.lotNo || req.query.lot_no);
  const expDate = normalizeDateOnlyQueryValue(req.query.expDate || req.query.exp_date, "expDate");

  if (lotId && !isUuid(lotId)) {
    throw httpError(400, "lotId must be a valid UUID");
  }
  if ((lotNo && !expDate) || (!lotNo && expDate)) {
    throw httpError(400, "lotNo and expDate must be provided together");
  }

  const productResult = await query(
    `
      SELECT id
      FROM products
      WHERE id = $1
      LIMIT 1
    `,
    [productId]
  );

  if (!productResult.rows[0]) {
    throw httpError(404, "Product not found");
  }

  const productLevelItems = (await listActiveProductUnitLevelRows({ query }, productId)).map(
    normalizeUnitLevelApiRow
  );
  const defaultProductUnitLevelId = toCleanText(
    productLevelItems.find((item) => item.isSellable)?.id || productLevelItems[0]?.id
  );
  const wantsLotContext = Boolean(lotId || (lotNo && expDate));

  function sendProductFallback(fallbackReason, lot = null) {
    return res.json({
      items: productLevelItems,
      scope: "product",
      hasLotWhitelist: false,
      fallbackReason: fallbackReason || null,
      defaultUnitLevelId: defaultProductUnitLevelId,
      lot: lot
        ? {
            id: toCleanText(lot.id),
            lotNo: toCleanText(lot.lotNo),
            expDate: toCleanText(lot.expDate),
          }
        : null,
    });
  }

  if (!wantsLotContext) {
    return sendProductFallback(null);
  }

  if (!(await hasProductLotAllowedUnitLevelsTable({ query }))) {
    return sendProductFallback("lot_whitelist_table_missing");
  }

  const lot = await findProductLotForUnitLevelLookup({ query }, productId, {
    lotId,
    lotNo,
    expDate,
  });
  if (!lot) {
    return sendProductFallback("lot_not_found");
  }

  const whitelistRows = await listLotAllowedUnitLevelRows({ query }, productId, lot.id);
  if (!whitelistRows.length) {
    return sendProductFallback("lot_whitelist_missing", lot);
  }

  const whitelistedItems = whitelistRows
    .filter((row) => toCleanText(row.id))
    .map(normalizeUnitLevelApiRow);
  const defaultWhitelistedUnitLevelId = toCleanText(
    whitelistedItems.find((item) => item.isDefault)?.id || whitelistedItems[0]?.id
  );

  return res.json({
    items: whitelistedItems,
    scope: "lot-whitelist",
    hasLotWhitelist: true,
    fallbackReason: whitelistedItems.length ? null : "lot_whitelist_has_no_active_unit_levels",
    defaultUnitLevelId: defaultWhitelistedUnitLevelId,
    lot: {
      id: toCleanText(lot.id),
      lotNo: toCleanText(lot.lotNo),
      expDate: toCleanText(lot.expDate),
    },
  });
}

export async function getProductLotWhitelists(req, res) {
  const productId = toCleanText(req.params.id || req.params.productId);
  if (!productId || !isUuid(productId)) {
    throw httpError(400, "product id must be a valid UUID");
  }

  const productResult = await query(
    `
      SELECT id
      FROM products
      WHERE id = $1
      LIMIT 1
    `,
    [productId]
  );

  if (!productResult.rows[0]) {
    throw httpError(404, "Product not found");
  }

  if (!(await hasProductLotAllowedUnitLevelsTable({ query }))) {
    throw httpError(
      409,
      "Lot whitelist management requires migration 0017_product_lot_allowed_unit_levels.sql"
    );
  }

  const [unitLevelRows, lotRows, mappingRows] = await Promise.all([
    listActiveProductUnitLevelRows({ query }, productId),
    listProductLots({ query }, productId, { includeLatestAudit: true }),
    listProductLotWhitelistMappings({ query }, productId),
  ]);

  const lotsById = new Map(
    lotRows.map((row) => [
      toCleanText(row.id),
      {
        id: toCleanText(row.id),
        lotNo: toCleanText(row.lotNo),
        mfgDate: toCleanText(row.mfgDate),
        expDate: toCleanText(row.expDate),
        manufacturerName: toCleanText(row.manufacturerName),
        hasWhitelist: false,
        allowedUnitLevelIds: [],
        defaultUnitLevelId: "",
        invalidUnitLevelIds: [],
        latestEditReason: toCleanText(row.latestEditReason),
        latestEditedAt: row.latestEditedAt || null,
        latestEditedByName: toCleanText(row.latestEditedByName),
        latestEditedByUsername: toCleanText(row.latestEditedByUsername),
      },
    ])
  );

  for (const row of mappingRows) {
    const lotId = toCleanText(row.productLotId);
    const unitLevelId = toCleanText(row.unitLevelId);
    if (!lotId || !unitLevelId) continue;

    const lot = lotsById.get(lotId);
    if (!lot) continue;

    lot.hasWhitelist = true;
    if (toCleanText(row.resolvedUnitLevelId)) {
      lot.allowedUnitLevelIds.push(unitLevelId);
      if (row.isDefault) {
        lot.defaultUnitLevelId = unitLevelId;
      }
    } else {
      lot.invalidUnitLevelIds.push(unitLevelId);
    }
  }

  return res.json({
    productId,
    unitLevels: unitLevelRows.map(normalizeUnitLevelApiRow),
    lots: [...lotsById.values()],
  });
}

export async function updateProductLotWhitelist(req, res) {
  const productId = toCleanText(req.params.id || req.params.productId);
  const lotId = toCleanText(req.params.lotId || req.params.productLotId);
  if (!productId) {
    throw httpError(400, "product id is required");
  }
  if (!lotId || !isUuid(lotId)) {
    throw httpError(400, "lotId must be a valid UUID");
  }

  if (!(await hasProductLotAllowedUnitLevelsTable({ query }))) {
    throw httpError(
      409,
      "Lot whitelist management requires migration 0017_product_lot_allowed_unit_levels.sql"
    );
  }

  const sourceAllowedUnitLevelIds = Array.isArray(req.body?.allowedUnitLevelIds)
    ? req.body.allowedUnitLevelIds
    : Array.isArray(req.body?.allowed_unit_level_ids)
    ? req.body.allowed_unit_level_ids
    : [];
  const allowedUnitLevelIds = [
    ...new Set(sourceAllowedUnitLevelIds.map((value) => toCleanText(value)).filter(Boolean)),
  ];
  const defaultUnitLevelId = toCleanText(
    req.body?.defaultUnitLevelId ?? req.body?.default_unit_level_id
  );

  if (allowedUnitLevelIds.some((value) => !isUuid(value))) {
    throw httpError(400, "allowedUnitLevelIds must contain valid UUIDs only");
  }
  if (defaultUnitLevelId && !isUuid(defaultUnitLevelId)) {
    throw httpError(400, "defaultUnitLevelId must be a valid UUID");
  }
  if (defaultUnitLevelId && !allowedUnitLevelIds.includes(defaultUnitLevelId)) {
    throw httpError(400, "defaultUnitLevelId must be included in allowedUnitLevelIds");
  }

  const productResult = await query(
    `
      SELECT id
      FROM products
      WHERE id = $1
      LIMIT 1
    `,
    [productId]
  );
  if (!productResult.rows[0]) {
    throw httpError(404, "Product not found");
  }

  const lotResult = await query(
    `
      SELECT id
      FROM product_lots
      WHERE id = $1::uuid
        AND product_id = $2
      LIMIT 1
    `,
    [lotId, productId]
  );
  if (!lotResult.rows[0]) {
    throw httpError(404, "Product lot not found");
  }

  const activeUnitLevelRows = await listActiveProductUnitLevelRows({ query }, productId);
  const activeUnitLevelIds = new Set(activeUnitLevelRows.map((row) => toCleanText(row.id)).filter(Boolean));
  for (const unitLevelId of allowedUnitLevelIds) {
    if (!activeUnitLevelIds.has(unitLevelId)) {
      throw httpError(
        400,
        "allowedUnitLevelIds must reference active product-level packaging only"
      );
    }
  }

  await withTransaction(async (client) => {
    if (!allowedUnitLevelIds.length) {
      await client.query(
        `
          UPDATE product_lot_allowed_unit_levels
          SET is_active = false,
              is_default = false,
              updated_at = now()
          WHERE product_id = $1
            AND product_lot_id = $2::uuid
            AND is_active = true
        `,
        [productId, lotId]
      );
      return;
    }

    await client.query(
      `
        UPDATE product_lot_allowed_unit_levels
        SET is_default = false,
            updated_at = now()
        WHERE product_id = $1
          AND product_lot_id = $2::uuid
          AND is_active = true
      `,
      [productId, lotId]
    );

    await client.query(
      `
        UPDATE product_lot_allowed_unit_levels
        SET is_active = false,
            is_default = false,
            updated_at = now()
        WHERE product_id = $1
          AND product_lot_id = $2::uuid
          AND is_active = true
          AND NOT (unit_level_id = ANY($3::uuid[]))
      `,
      [productId, lotId, allowedUnitLevelIds]
    );

    for (const unitLevelId of allowedUnitLevelIds) {
      await client.query(
        `
          INSERT INTO product_lot_allowed_unit_levels (
            product_id,
            product_lot_id,
            unit_level_id,
            is_default,
            is_active,
            source_type,
            note_text,
            updated_at
          )
          VALUES ($1, $2::uuid, $3::uuid, $4, true, 'MANUAL', 'Updated via admin lot whitelist UI', now())
          ON CONFLICT (product_lot_id, unit_level_id)
          DO UPDATE
          SET is_default = EXCLUDED.is_default,
              is_active = true,
              source_type = EXCLUDED.source_type,
              note_text = EXCLUDED.note_text,
              updated_at = now()
        `,
        [productId, lotId, unitLevelId, defaultUnitLevelId === unitLevelId]
      );
    }
  });

  return res.json({
    ok: true,
    productId,
    lotId,
    allowedUnitLevelIds,
    defaultUnitLevelId: defaultUnitLevelId || null,
  });
}

export async function updateProductLotMetadata(req, res) {
  const productId = toCleanText(req.params.id || req.params.productId);
  const lotId = toCleanText(req.params.lotId || req.params.productLotId);
  const editedByUserId = toCleanText(req.user?.id);

  if (!productId) {
    throw httpError(400, "product id is required");
  }
  if (!lotId || !isUuid(lotId)) {
    throw httpError(400, "lotId must be a valid UUID");
  }
  if (!editedByUserId || !isUuid(editedByUserId)) {
    throw httpError(401, "Authentication required");
  }
  if (!(await hasProductLotEditAuditsTable({ query }))) {
    throw httpError(
      409,
      "Lot metadata incident logging requires migration 0019_product_lot_edit_audits.sql"
    );
  }

  const input = normalizeLotMetadataUpdateInput(req.body);

  const result = await withTransaction(async (client) => {
    const existingLotResult = await client.query(
      `
        SELECT
          pl.id,
          pl.product_id AS "productId",
          pl.lot_no AS "lotNo",
          pl.mfg_date::text AS "mfgDate",
          pl.exp_date::text AS "expDate",
          pl.manufacturer_name AS "manufacturerName"
        FROM product_lots pl
        WHERE pl.id = $1::uuid
          AND pl.product_id = $2
        LIMIT 1
        FOR UPDATE
      `,
      [lotId, productId]
    );

    const existingLot = existingLotResult.rows[0];
    if (!existingLot) {
      throw httpError(404, "Product lot not found");
    }

    const hasChange =
      input.lotNo !== toCleanText(existingLot.lotNo) ||
      input.mfgDate !== (toCleanText(existingLot.mfgDate) || null) ||
      input.expDate !== toCleanText(existingLot.expDate);

    if (!hasChange) {
      throw httpError(400, "No lot metadata change detected");
    }

    const duplicateResult = await client.query(
      `
        SELECT id
        FROM product_lots
        WHERE product_id = $1
          AND lot_no = $2
          AND exp_date = $3::date
          AND id <> $4::uuid
        LIMIT 1
      `,
      [productId, input.lotNo, input.expDate, lotId]
    );

    if (duplicateResult.rows[0]) {
      throw httpError(409, "Another lot already uses this lot number and expiry date");
    }

    const updatedLotResult = await client.query(
      `
        UPDATE product_lots
        SET lot_no = $2,
            mfg_date = $3::date,
            exp_date = $4::date
        WHERE id = $1::uuid
        RETURNING
          id,
          product_id AS "productId",
          lot_no AS "lotNo",
          mfg_date::text AS "mfgDate",
          exp_date::text AS "expDate",
          manufacturer_name AS "manufacturerName"
      `,
      [lotId, input.lotNo, input.mfgDate, input.expDate]
    );

    await client.query(
      `
        INSERT INTO product_lot_edit_audits (
          product_lot_id,
          product_id,
          previous_lot_no,
          new_lot_no,
          previous_mfg_date,
          new_mfg_date,
          previous_exp_date,
          new_exp_date,
          reason_text,
          edited_by
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3,
          $4,
          $5::date,
          $6::date,
          $7::date,
          $8::date,
          $9,
          $10::uuid
        )
      `,
      [
        lotId,
        productId,
        existingLot.lotNo,
        input.lotNo,
        existingLot.mfgDate || null,
        input.mfgDate,
        existingLot.expDate,
        input.expDate,
        input.reason,
        editedByUserId,
      ]
    );

    return updatedLotResult.rows[0];
  });

  return res.json({
    ok: true,
    productId,
    lot: {
      id: toCleanText(result.id),
      productId: toCleanText(result.productId),
      lotNo: toCleanText(result.lotNo),
      mfgDate: toCleanText(result.mfgDate),
      expDate: toCleanText(result.expDate),
      expDateDisplay: formatDateOnlyDisplay(result.expDate),
      manufacturerName: toCleanText(result.manufacturerName),
    },
  });
}

export async function normalizeProductLot(req, res) {
  const productId = toCleanText(req.params.id || req.params.productId);
  const normalizedByUserId = toCleanText(req.user?.id);

  if (!productId || !isUuid(productId)) {
    throw httpError(400, "product id must be a valid UUID");
  }
  if (!normalizedByUserId || !isUuid(normalizedByUserId)) {
    throw httpError(401, "Authentication required");
  }
  if (!(await hasProductLotNormalizationAuditsTable({ query }))) {
    throw httpError(
      409,
      "Lot normalization audit table requires migration 0025_product_lot_normalization_audits.sql"
    );
  }

  const input = normalizeLotNormalizationInput(req.body);

  const result = await withTransaction(async (client) => {
    const sourceLotResult = await client.query(
      `
        SELECT
          id,
          product_id AS "productId",
          lot_no AS "lotNo",
          mfg_date::text AS "mfgDate",
          exp_date::text AS "expDate",
          manufacturer_name AS "manufacturerName"
        FROM product_lots
        WHERE id = $1::uuid
          AND product_id = $2::uuid
        LIMIT 1
        FOR UPDATE
      `,
      [input.sourceLotId, productId]
    );
    const sourceLot = sourceLotResult.rows[0];
    if (!sourceLot) {
      throw httpError(404, "Source product lot not found");
    }

    let targetLot = null;
    if (input.targetLotId && input.targetLotId !== input.sourceLotId) {
      const targetByIdResult = await client.query(
        `
          SELECT
            id,
            product_id AS "productId",
            lot_no AS "lotNo",
            mfg_date::text AS "mfgDate",
            exp_date::text AS "expDate",
            manufacturer_name AS "manufacturerName"
          FROM product_lots
          WHERE id = $1::uuid
            AND product_id = $2::uuid
          LIMIT 1
          FOR UPDATE
        `,
        [input.targetLotId, productId]
      );
      targetLot = targetByIdResult.rows[0] || null;
      if (!targetLot) {
        throw httpError(404, "Target product lot not found");
      }
    }

    if (!targetLot) {
      const targetByMetadataResult = await client.query(
        `
          SELECT
            id,
            product_id AS "productId",
            lot_no AS "lotNo",
            mfg_date::text AS "mfgDate",
            exp_date::text AS "expDate",
            manufacturer_name AS "manufacturerName"
          FROM product_lots
          WHERE product_id = $1::uuid
            AND lot_no = $2
            AND exp_date = $3::date
            AND id <> $4::uuid
          LIMIT 1
          FOR UPDATE
        `,
        [productId, input.targetLotNo, input.targetExpDate, input.sourceLotId]
      );
      targetLot = targetByMetadataResult.rows[0] || null;
    }

    if (!targetLot) {
      const hasChange =
        input.targetLotNo !== toCleanText(sourceLot.lotNo) ||
        input.targetMfgDate !== (toCleanText(sourceLot.mfgDate) || null) ||
        input.targetExpDate !== toCleanText(sourceLot.expDate);

      if (!hasChange) {
        throw httpError(400, "No lot normalization change detected");
      }

      const updatedLotResult = await client.query(
        `
          UPDATE product_lots
          SET lot_no = $2,
              mfg_date = $3::date,
              exp_date = $4::date
          WHERE id = $1::uuid
          RETURNING
            id,
            product_id AS "productId",
            lot_no AS "lotNo",
            mfg_date::text AS "mfgDate",
            exp_date::text AS "expDate",
            manufacturer_name AS "manufacturerName"
        `,
        [input.sourceLotId, input.targetLotNo, input.targetMfgDate, input.targetExpDate]
      );
      const updatedLot = updatedLotResult.rows[0];

      if (await hasProductLotEditAuditsTable(client)) {
        await client.query(
          `
            INSERT INTO product_lot_edit_audits (
              product_lot_id,
              product_id,
              previous_lot_no,
              new_lot_no,
              previous_mfg_date,
              new_mfg_date,
              previous_exp_date,
              new_exp_date,
              reason_text,
              edited_by
            )
            VALUES (
              $1::uuid,
              $2::uuid,
              $3,
              $4,
              $5::date,
              $6::date,
              $7::date,
              $8::date,
              $9,
              $10::uuid
            )
          `,
          [
            input.sourceLotId,
            productId,
            sourceLot.lotNo,
            input.targetLotNo,
            sourceLot.mfgDate || null,
            input.targetMfgDate,
            sourceLot.expDate,
            input.targetExpDate,
            input.reason,
            normalizedByUserId,
          ]
        );
      }

      await client.query(
        `
          INSERT INTO product_lot_normalization_audits (
            product_id,
            operation_type,
            source_lot_id,
            target_lot_id,
            source_lot_no,
            target_lot_no,
            source_mfg_date,
            target_mfg_date,
            source_exp_date,
            target_exp_date,
            reason_text,
            normalized_by
          )
          VALUES ($1::uuid, 'RENAME', $2::uuid, $2::uuid, $3, $4, $5::date, $6::date, $7::date, $8::date, $9, $10::uuid)
        `,
        [
          productId,
          input.sourceLotId,
          sourceLot.lotNo,
          updatedLot.lotNo,
          sourceLot.mfgDate || null,
          updatedLot.mfgDate || null,
          sourceLot.expDate,
          updatedLot.expDate,
          input.reason,
          normalizedByUserId,
        ]
      );

      return {
        operation: "RENAME",
        sourceLot,
        targetLot: updatedLot,
        counts: {
          stockOnHandRowsRebuilt: 0,
          stockMovementRowsUpdated: 0,
          dispenseLineRowsUpdated: 0,
          transferRequestRowsUpdated: 0,
          incidentItemRowsUpdated: 0,
          incidentResolutionRowsUpdated: 0,
          stockMovementDeleteAuditRowsUpdated: 0,
          lotWhitelistRowsRemoved: 0,
        },
      };
    }

    if (toCleanText(targetLot.id) === toCleanText(sourceLot.id)) {
      throw httpError(400, "Source and target lot are the same");
    }

    const stockOnHandRebuildResult = await client.query(
      `
        INSERT INTO stock_on_hand (
          branch_id,
          product_id,
          lot_id,
          base_unit_level_id,
          quantity_on_hand,
          updated_at
        )
        SELECT
          branch_id,
          product_id,
          $3::uuid AS lot_id,
          base_unit_level_id,
          SUM(quantity_on_hand) AS quantity_on_hand,
          now() AS updated_at
        FROM stock_on_hand
        WHERE product_id = $1::uuid
          AND lot_id = $2::uuid
        GROUP BY branch_id, product_id, base_unit_level_id
        ON CONFLICT (branch_id, product_id, lot_id, base_unit_level_id)
        DO UPDATE
          SET quantity_on_hand = stock_on_hand.quantity_on_hand + EXCLUDED.quantity_on_hand,
              updated_at = now()
        RETURNING id
      `,
      [productId, sourceLot.id, targetLot.id]
    );

    await client.query(
      `
        DELETE FROM stock_on_hand
        WHERE product_id = $1::uuid
          AND lot_id = $2::uuid
      `,
      [productId, sourceLot.id]
    );

    const stockMovementResult = await client.query(
      `
        UPDATE stock_movements
        SET lot_id = $3::uuid
        WHERE product_id = $1::uuid
          AND lot_id = $2::uuid
      `,
      [productId, sourceLot.id, targetLot.id]
    );

    const dispenseLineResult = await client.query(
      `
        UPDATE dispense_lines
        SET lot_id = $3::uuid
        WHERE product_id = $1::uuid
          AND lot_id = $2::uuid
      `,
      [productId, sourceLot.id, targetLot.id]
    );

    const transferRequestResult = await client.query(
      `
        UPDATE inventory_transfer_requests
        SET lot_id = $3::uuid
        WHERE product_id = $1::uuid
          AND lot_id = $2::uuid
      `,
      [productId, sourceLot.id, targetLot.id]
    );

    const incidentItemResult = await client.query(
      `
        UPDATE incident_report_items
        SET lot_id = $3::uuid
        WHERE product_id = $1::uuid
          AND lot_id = $2::uuid
      `,
      [productId, sourceLot.id, targetLot.id]
    );

    let incidentResolutionRowsUpdated = 0;
    if (await hasPublicTable(client, "incident_report_resolution_actions")) {
      const incidentResolutionResult = await client.query(
        `
          UPDATE incident_report_resolution_actions
          SET lot_id = $3::uuid
          WHERE product_id = $1::uuid
            AND lot_id = $2::uuid
        `,
        [productId, sourceLot.id, targetLot.id]
      );
      incidentResolutionRowsUpdated = incidentResolutionResult.rowCount;
    }

    let stockMovementDeleteAuditRowsUpdated = 0;
    if (await hasPublicTable(client, "stock_movement_delete_audits")) {
      const deleteAuditResult = await client.query(
        `
          UPDATE stock_movement_delete_audits
          SET lot_id = $3::uuid
          WHERE product_id = $1::uuid
            AND lot_id = $2::uuid
        `,
        [productId, sourceLot.id, targetLot.id]
      );
      stockMovementDeleteAuditRowsUpdated = deleteAuditResult.rowCount;
    }

    let lotWhitelistRowsRemoved = 0;
    if (await hasProductLotAllowedUnitLevelsTable(client)) {
      await client.query(
        `
          WITH target_default AS (
            SELECT EXISTS (
              SELECT 1
              FROM product_lot_allowed_unit_levels
              WHERE product_lot_id = $3::uuid
                AND is_active = true
                AND is_default = true
            ) AS has_default
          )
          INSERT INTO product_lot_allowed_unit_levels (
            product_id,
            product_lot_id,
            unit_level_id,
            is_default,
            is_active,
            source_type,
            note_text,
            created_at,
            updated_at
          )
          SELECT
            plaul.product_id,
            $3::uuid,
            plaul.unit_level_id,
            CASE
              WHEN plaul.is_default = true
                AND (SELECT has_default FROM target_default) = false
              THEN true
              ELSE false
            END,
            plaul.is_active,
            'LOT_NORMALIZATION',
            CONCAT('Copied from merged lot ', $2::text),
            now(),
            now()
          FROM product_lot_allowed_unit_levels plaul
          WHERE plaul.product_id = $1::uuid
            AND plaul.product_lot_id = $2::uuid
            AND plaul.is_active = true
          ON CONFLICT (product_lot_id, unit_level_id) DO NOTHING
        `,
        [productId, sourceLot.id, targetLot.id]
      );

      const deleteWhitelistResult = await client.query(
        `
          DELETE FROM product_lot_allowed_unit_levels
          WHERE product_id = $1::uuid
            AND product_lot_id = $2::uuid
        `,
        [productId, sourceLot.id]
      );
      lotWhitelistRowsRemoved = deleteWhitelistResult.rowCount;
    }

    await client.query(
      `
        DELETE FROM product_lots
        WHERE product_id = $1::uuid
          AND id = $2::uuid
      `,
      [productId, sourceLot.id]
    );

    const counts = {
      stockOnHandRowsRebuilt: stockOnHandRebuildResult.rowCount,
      stockMovementRowsUpdated: stockMovementResult.rowCount,
      dispenseLineRowsUpdated: dispenseLineResult.rowCount,
      transferRequestRowsUpdated: transferRequestResult.rowCount,
      incidentItemRowsUpdated: incidentItemResult.rowCount,
      incidentResolutionRowsUpdated,
      stockMovementDeleteAuditRowsUpdated,
      lotWhitelistRowsRemoved,
    };

    await client.query(
      `
        INSERT INTO product_lot_normalization_audits (
          product_id,
          operation_type,
          source_lot_id,
          target_lot_id,
          source_lot_no,
          target_lot_no,
          source_mfg_date,
          target_mfg_date,
          source_exp_date,
          target_exp_date,
          reason_text,
          stock_on_hand_rows_rebuilt,
          stock_movement_rows_updated,
          dispense_line_rows_updated,
          transfer_request_rows_updated,
          incident_item_rows_updated,
          incident_resolution_rows_updated,
          stock_movement_delete_audit_rows_updated,
          lot_whitelist_rows_removed,
          normalized_by
        )
        VALUES (
          $1::uuid,
          'MERGE',
          $2::uuid,
          $3::uuid,
          $4,
          $5,
          $6::date,
          $7::date,
          $8::date,
          $9::date,
          $10,
          $11,
          $12,
          $13,
          $14,
          $15,
          $16,
          $17,
          $18,
          $19::uuid
        )
      `,
      [
        productId,
        sourceLot.id,
        targetLot.id,
        sourceLot.lotNo,
        targetLot.lotNo,
        sourceLot.mfgDate || null,
        targetLot.mfgDate || null,
        sourceLot.expDate,
        targetLot.expDate,
        input.reason,
        counts.stockOnHandRowsRebuilt,
        counts.stockMovementRowsUpdated,
        counts.dispenseLineRowsUpdated,
        counts.transferRequestRowsUpdated,
        counts.incidentItemRowsUpdated,
        counts.incidentResolutionRowsUpdated,
        counts.stockMovementDeleteAuditRowsUpdated,
        counts.lotWhitelistRowsRemoved,
        normalizedByUserId,
      ]
    );

    return {
      operation: "MERGE",
      sourceLot,
      targetLot,
      counts,
    };
  });

  return res.json({
    ok: true,
    productId,
    operation: result.operation,
    sourceLot: {
      id: toCleanText(result.sourceLot.id),
      lotNo: toCleanText(result.sourceLot.lotNo),
      mfgDate: toCleanText(result.sourceLot.mfgDate),
      expDate: toCleanText(result.sourceLot.expDate),
    },
    targetLot: {
      id: toCleanText(result.targetLot.id),
      lotNo: toCleanText(result.targetLot.lotNo),
      mfgDate: toCleanText(result.targetLot.mfgDate),
      expDate: toCleanText(result.targetLot.expDate),
      expDateDisplay: formatDateOnlyDisplay(result.targetLot.expDate),
    },
    counts: result.counts,
  });
}

export async function getReportGroups(_req, res) {
  const result = await query(
    `
      SELECT
        code,
        thai_name AS "thaiName",
        description
      FROM report_groups
      WHERE is_active = true
      ORDER BY code ASC
    `
  );

  return res.json(result.rows);
}

export async function getActiveIngredients(req, res) {
  const searchText = toCleanText(req.query.q);
  const pattern = `%${searchText}%`;
  const limitRaw = Number(req.query.limit);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.max(Math.floor(limitRaw), 1), 500)
      : 200;

  const result = await query(
    `
      SELECT
        id::text AS id,
        code,
        name_en AS "nameEn"
      FROM active_ingredients
      WHERE is_active = true
        AND (
          $1::text = ''
          OR name_en ILIKE $2
          OR COALESCE(name_th, '') ILIKE $2
          OR code ILIKE $2
        )
      ORDER BY name_en ASC
      LIMIT $3
    `,
    [searchText, pattern, limit]
  );

  return res.json({ items: result.rows });
}

export async function getUnitTypes(req, res) {
  const searchText = toCleanText(req.query.q);
  const pattern = `%${searchText}%`;
  const limitRaw = Number(req.query.limit);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.max(Math.floor(limitRaw), 1), 500)
      : 200;

  const result = await query(
    `
      SELECT
        id::text AS id,
        code,
        name_en AS "nameEn",
        name_th AS "nameTh",
        unit_kind AS "unitKind",
        symbol
      FROM unit_types
      WHERE is_active = true
        AND code = ANY($4::text[])
        AND (
          $1::text = ''
          OR code ILIKE $2
          OR name_en ILIKE $2
          OR COALESCE(name_th, '') ILIKE $2
          OR COALESCE(symbol, '') ILIKE $2
        )
      ORDER BY code ASC
      LIMIT $3
    `,
    [searchText, pattern, limit, INGREDIENT_UNIT_TYPE_CODES]
  );

  return res.json({ items: result.rows });
}

export async function getGenericNames(_req, res) {
  const result = await query(
    `
      SELECT DISTINCT UPPER(TRIM(generic_name)) AS generic_name
      FROM products
      WHERE generic_name IS NOT NULL
        AND TRIM(generic_name) <> ''
      ORDER BY generic_name ASC
    `
  );

  return res.json({
    generic_names: result.rows.map((row) => row.generic_name).filter(Boolean),
  });
}

export async function getProductsSnapshot(_req, res) {
  const activePredicate = productUnitLevelsActiveCompatPredicate("pul");
  const result = await query(
    `
      SELECT
        p.id AS product_id,
        pul.barcode,
        p.product_code,
        p.trade_name,
        COALESCE(pp.price, 0) AS price,
        ut.symbol AS unit_symbol,
        COALESCE(pr.report_group_codes, ARRAY[]::text[]) AS report_group_codes
      FROM product_unit_levels pul
      JOIN products p ON p.id = pul.product_id
      LEFT JOIN unit_types ut ON ut.id = pul.unit_type_id
      LEFT JOIN LATERAL (
        SELECT array_agg(rg.code ORDER BY rg.code) AS report_group_codes
        FROM product_report_groups prg
        JOIN report_groups rg ON rg.id = prg.report_group_id
        WHERE prg.product_id = p.id
          AND prg.effective_from <= CURRENT_DATE
          AND (prg.effective_to IS NULL OR prg.effective_to > CURRENT_DATE)
      ) pr ON true
      LEFT JOIN LATERAL (
        SELECT pp.price
        FROM product_prices pp
        LEFT JOIN price_tiers pt ON pt.id = pp.price_tier_id
        WHERE pp.product_id = p.id
          AND pp.unit_level_id = pul.id
          AND (pp.effective_to IS NULL OR pp.effective_to >= CURRENT_DATE)
        ORDER BY
          COALESCE(pt.is_default, false) DESC,
          pp.effective_from DESC
        LIMIT 1
      ) pp ON true
      WHERE p.is_active = true
        AND pul.barcode IS NOT NULL
        AND ${activePredicate}
      ORDER BY p.trade_name ASC
      LIMIT 5000
    `
  );

  return res.json(
    result.rows.map((row) => ({
      id: row.product_id,
      barcode: row.barcode,
      product_code: row.product_code,
      product_name: row.trade_name,
      price_baht: Number(row.price || 0),
      qty_per_unit: 1,
      unit: row.unit_symbol || "",
      reportGroupCodes: Array.isArray(row.report_group_codes) ? row.report_group_codes : [],
    }))
  );
}

export async function getProductsVersion(_req, res) {
  const result = await query(
    `
      SELECT
        to_char(MAX(ts), 'YYYYMMDDHH24MISSMS') AS version
      FROM (
        SELECT MAX(updated_at) AS ts FROM products
        UNION ALL
        SELECT MAX(created_at) AS ts FROM product_unit_levels
        UNION ALL
        SELECT MAX(created_at) AS ts FROM product_prices
        UNION ALL
        SELECT MAX(updated_at) AS ts FROM report_groups
        UNION ALL
        SELECT MAX(GREATEST(created_at, COALESCE(effective_to::timestamptz, created_at))) AS ts FROM product_report_groups
      ) q
    `
  );

  return res.json({ version: result.rows[0]?.version || "0" });
}

export async function createProduct(req, res) {
  const body = req.body || {};
  const tradeName = toCleanText(body.tradeName || body.trade_name);
  if (!tradeName) {
    throw httpError(400, "tradeName is required");
  }

  const hasIngredientsField = hasOwnField(body, "ingredients");
  const ingredients = hasIngredientsField ? normalizeIngredientsInput(body.ingredients) : [];
  const { reportGroupCodes } = normalizeReportGroupCodesInput(body);
  const reportReceiveUnitSelection = normalizeReportReceiveUnitSelectionInput(body);
  const { hasPackagingLevelsField, packagingLevels } = normalizePackagingLevelsInput(body);
  const genericNameInput = toCleanText(body.genericName || body.generic_name);
  const barcode = toCleanText(body.barcode);
  const manufacturerName = toCleanText(body.manufacturerName || body.importerName);
  const packageSize = toCleanText(body.packageSize || body.packageLabel || body.package_notes);
  const unitTypeCode = toCleanText(body.unitTypeCode || body.unit_code).toUpperCase();
  const price = parseOptionalNonNegativeNumber(body.price, "price");
  const shouldUpsertUnit =
    hasOwnField(body, "barcode") ||
    hasOwnField(body, "packageSize") ||
    hasOwnField(body, "packageLabel") ||
    hasOwnField(body, "package_notes") ||
    hasOwnField(body, "unitTypeCode") ||
    hasOwnField(body, "unit_code") ||
    hasPackagingLevelsField ||
    price !== null;

  const productId = await withTransaction(async (client) => {
    const normalizedIngredients = hasIngredientsField
      ? await hydrateIngredientsByActiveIngredientId(client, ingredients)
      : [];
    const dosageFormId = await resolveDosageFormId(
      client,
      body.dosageFormCode || body.dosage_form_code,
      body.dosageFormNameTh || body.dosage_form_name_th
    );
    const manufacturerLocationId = manufacturerName
      ? await resolveManufacturerLocationId(client, manufacturerName)
      : null;

    const inserted = await client.query(
      `
        INSERT INTO products (
          product_code,
          trade_name,
          generic_name,
          dosage_form_id,
          manufacturer_location_id,
          note_text,
          is_active,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, true, now())
        RETURNING id
      `,
      [
        toCleanText(body.productCode || body.product_code) || null,
        tradeName,
        normalizedIngredients.length
          ? composeGenericName(normalizedIngredients)
          : genericNameInput || null,
        dosageFormId,
        manufacturerLocationId,
        toCleanText(body.noteText || body.note_text) || null,
      ]
    );

    const createdProductId = inserted.rows[0].id;
    if (hasIngredientsField) {
      await syncProductIngredients(client, createdProductId, normalizedIngredients);
    }
    if (reportGroupCodes.length) {
      await syncProductReportGroups(client, createdProductId, reportGroupCodes);
    }
    if (hasPackagingLevelsField) {
      await syncPackagingLevelsAndPrice(client, createdProductId, packagingLevels, price);
    } else {
      await upsertPrimaryUnitLevelAndPrice(client, createdProductId, {
        shouldUpsertUnit,
        barcode,
        packageSize,
        unitTypeCode,
        price,
      });
    }

    await syncProductReportReceiveUnitSelection(client, createdProductId, reportReceiveUnitSelection, {
      fallbackToPrimary: true,
    });

    return createdProductId;
  });

  const created = await getProductById(productId);
  if (!created) {
    throw httpError(500, "Unable to load created product");
  }

  return res.status(201).json(created);
}

export async function updateProduct(req, res) {
  const id = req.params.id;
  const existing = await query(
    `
      SELECT
        id,
        product_code,
        generic_name,
        dosage_form_id,
        manufacturer_location_id,
        note_text,
        is_active
      FROM products
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  );

  if (!existing.rows[0]) {
    throw httpError(404, "Product not found");
  }

  const body = req.body || {};
  const tradeName = toCleanText(body.tradeName || body.trade_name);
  if (!tradeName) {
    throw httpError(400, "tradeName is required");
  }

  const hasIngredientsField = hasOwnField(body, "ingredients");
  const ingredients = hasIngredientsField ? normalizeIngredientsInput(body.ingredients) : [];
  const { hasReportGroupField, reportGroupCodes } = normalizeReportGroupCodesInput(body);
  const reportReceiveUnitSelection = normalizeReportReceiveUnitSelectionInput(body);
  const { hasPackagingLevelsField, packagingLevels } = normalizePackagingLevelsInput(body);
  const hasGenericNameField = hasOwnField(body, "genericName") || hasOwnField(body, "generic_name");
  const genericNameInput = toCleanText(body.genericName || body.generic_name);
  const hasIsActiveField = hasOwnField(body, "isActive") || hasOwnField(body, "is_active");
  const hasDosageFormField =
    hasOwnField(body, "dosageFormCode") || hasOwnField(body, "dosage_form_code");
  const hasProductCodeField = hasOwnField(body, "productCode") || hasOwnField(body, "product_code");
  const hasNoteField = hasOwnField(body, "noteText") || hasOwnField(body, "note_text");
  const hasManufacturerField =
    hasOwnField(body, "manufacturerName") || hasOwnField(body, "importerName");
  const hasBarcodeField = hasOwnField(body, "barcode");
  const hasPackageSizeField =
    hasOwnField(body, "packageSize") ||
    hasOwnField(body, "packageLabel") ||
    hasOwnField(body, "package_notes");
  const hasUnitTypeCodeField = hasOwnField(body, "unitTypeCode") || hasOwnField(body, "unit_code");
  const hasPriceField = hasOwnField(body, "price");
  const barcode = toCleanText(body.barcode);
  const packageSize = toCleanText(body.packageSize || body.packageLabel || body.package_notes);
  const unitTypeCode = toCleanText(body.unitTypeCode || body.unit_code).toUpperCase();
  const manufacturerName = toCleanText(body.manufacturerName || body.importerName);
  const price = hasPriceField ? parseOptionalNonNegativeNumber(body.price, "price") : null;
  const shouldUpsertUnit =
    hasBarcodeField || hasPackageSizeField || hasUnitTypeCodeField || hasPriceField || hasPackagingLevelsField;
  const hasPackagingDefinitionChange =
    hasPackagingLevelsField || hasBarcodeField || hasPackageSizeField || hasUnitTypeCodeField;
  const shouldSyncReportReceiveUnit =
    reportReceiveUnitSelection.hasField || hasPackagingDefinitionChange;

  const current = existing.rows[0];
  const nextIsActive = hasIsActiveField
    ? parseBoolean(body.isActive ?? body.is_active, current.is_active)
    : current.is_active;

  const nextProductCode = hasProductCodeField
    ? toCleanText(body.productCode || body.product_code) || null
    : current.product_code;

  const nextNoteText = hasNoteField
    ? toCleanText(body.noteText || body.note_text) || null
    : current.note_text;
  await withTransaction(async (client) => {
    const fallbackReportReceiveUnitSelection =
      shouldSyncReportReceiveUnit && !reportReceiveUnitSelection.hasField
        ? await getStoredReportReceiveUnitSelection(client, id)
        : null;
    const normalizedIngredients = hasIngredientsField
      ? await hydrateIngredientsByActiveIngredientId(client, ingredients)
      : [];
    let genericName = current.generic_name;
    if (hasIngredientsField) {
      if (normalizedIngredients.length) {
        genericName = composeGenericName(normalizedIngredients);
      } else if (hasGenericNameField) {
        genericName = genericNameInput || null;
      }
    } else if (hasGenericNameField) {
      genericName = genericNameInput || null;
    }

    const dosageFormId = hasDosageFormField
      ? await resolveDosageFormId(
          client,
          body.dosageFormCode || body.dosage_form_code,
          body.dosageFormNameTh || body.dosage_form_name_th
        )
      : current.dosage_form_id;
    const nextManufacturerLocationId = hasManufacturerField
      ? manufacturerName
        ? await resolveManufacturerLocationId(client, manufacturerName)
        : null
      : current.manufacturer_location_id;

    await client.query(
      `
        UPDATE products
        SET
          product_code = $2,
          trade_name = $3,
          generic_name = $4,
          dosage_form_id = $5,
          manufacturer_location_id = $6,
          note_text = $7,
          is_active = $8,
          updated_at = now()
        WHERE id = $1
      `,
      [
        id,
        nextProductCode,
        tradeName,
        genericName,
        dosageFormId,
        nextManufacturerLocationId,
        nextNoteText,
        nextIsActive,
      ]
    );

    if (hasIngredientsField) {
      await syncProductIngredients(client, id, normalizedIngredients);
    }
    if (hasReportGroupField) {
      await syncProductReportGroups(client, id, reportGroupCodes);
    }
    if (hasPackagingLevelsField) {
      await syncPackagingLevelsAndPrice(client, id, packagingLevels, price);
    } else if (shouldUpsertUnit) {
      await upsertPrimaryUnitLevelAndPrice(client, id, {
        shouldUpsertUnit,
        barcode: hasBarcodeField ? barcode : undefined,
        packageSize: hasPackageSizeField ? packageSize : "",
        unitTypeCode: hasUnitTypeCodeField ? unitTypeCode : "",
        price,
      });
    }

    if (shouldSyncReportReceiveUnit) {
      await syncProductReportReceiveUnitSelection(
        client,
        id,
        reportReceiveUnitSelection.hasField ? reportReceiveUnitSelection : fallbackReportReceiveUnitSelection,
        {
          fallbackToPrimary: true,
        }
      );
    }
  });

  const updated = await getProductById(id);
  if (!updated) {
    throw httpError(500, "Unable to load updated product");
  }

  return res.json(updated);
}

export async function deleteProduct(req, res) {
  const id = req.params.id;
  const result = await query(
    `
      UPDATE products
      SET is_active = false, updated_at = now()
      WHERE id = $1
      RETURNING id
    `,
    [id]
  );

  if (!result.rows[0]) {
    throw httpError(404, "Product not found");
  }

  return res.status(204).send();
}
