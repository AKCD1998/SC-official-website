import { createHash, randomUUID } from "crypto";
import { httpError } from "../utils/httpError.js";

const SYSTEM_USERNAME = "system";
const DEFAULT_SYSTEM_PASSWORD_HASH = "$2b$10$M2M6PmdM1Q9hIBDwa7Jx0u2fBw8LZg/XiP7nM7G0X2j4VdZG2M53a";
const STABLE_UNIT_CODE_PREFIX = "ULK_";
const STABLE_UNIT_CODE_LENGTH = 48;

let hasUnitKeyColumnCache = null;
let hasProductUnitLevelsIsActiveColumnCache = null;
let hasProductLotAllowedUnitLevelsTableCache = null;
let unitKeyLegacyWarningPrinted = false;
let lotWhitelistTableMissingWarningPrinted = false;
let lotWhitelistTableIncompleteWarningPrinted = false;

const PRODUCT_LOT_ALLOWED_UNIT_LEVELS_REQUIRED_COLUMNS = [
  "product_id",
  "product_lot_id",
  "unit_level_id",
  "is_active",
  "is_default",
];

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeWhitespace(value) {
  return normalizeText(value).replace(/\s+/g, " ");
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    normalizeText(value)
  );
}

function normalizeUnitCode(unitLabel) {
  return String(unitLabel || "")
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function unitKindFromCode(code) {
  if (["MG", "MCG", "G"].includes(code)) return "MASS";
  if (["ML", "L"].includes(code)) return "VOLUME";
  if (["TABLET", "CAPSULE", "TAB", "CAP", "INHALATION"].includes(code)) return "COUNT";
  return "PACKAGE";
}

function getUnitTypeCodeFromUnitLevel(unitLevel) {
  return toAsciiToken(
    getUnitKeyToken(unitLevel?.unit_key, "ut") ??
      getUnitKeyToken(unitLevel?.unitKey, "ut") ??
      unitLevel?.unit_type_code ??
      unitLevel?.unitTypeCode ??
      unitLevel?.code,
    ""
  );
}

function requiresWholeQuantity(unitLevel) {
  const unitTypeCode = getUnitTypeCodeFromUnitLevel(unitLevel);
  if (!unitTypeCode) return false;
  const kind = unitKindFromCode(unitTypeCode);
  return kind === "COUNT" || kind === "PACKAGE";
}

function toPositiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const integerValue = Math.floor(numeric);
  return integerValue > 0 ? integerValue : null;
}

function toNonNegativeInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const integerValue = Math.floor(numeric);
  return integerValue >= 0 ? integerValue : null;
}

function toPositiveNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
}

function formatNumericToken(value, fallback = "1") {
  const numeric = toPositiveNumber(value);
  if (numeric === null) return fallback;
  const text = numeric.toString();
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

function toAsciiToken(value, fallback = "NA") {
  const token = normalizeText(value)
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return token || fallback;
}

function hasCorruptedDisplayName(value) {
  const text = normalizeText(value);
  if (!text) return true;
  return text.includes("?") || text.includes("\uFFFD");
}

function extractNumericHintsFromLabel(unitLabel) {
  const matches = [...String(unitLabel || "").matchAll(/[0-9]+(?:\.[0-9]+)?/g)].map((entry) =>
    Number(entry[0])
  );
  if (matches.length >= 2) {
    return {
      quantityPerParentUnit: matches[1],
      quantityPerBaseUnit: matches[matches.length - 1],
    };
  }
  if (matches.length === 1) {
    return {
      quantityPerParentUnit: matches[0],
      quantityPerBaseUnit: matches[0],
    };
  }
  return {
    quantityPerParentUnit: 1,
    quantityPerBaseUnit: 1,
  };
}

function normalizeUnitStructure(unitStructure, numericHints, defaultBaseUnitCode, unitTypeCode) {
  const source = unitStructure && typeof unitStructure === "object" ? unitStructure : {};
  const level =
    toPositiveInteger(
      source.level ??
        source.unitLevel ??
        source.unit_level ??
        source.levelNo ??
        source.level_no ??
        source.sortOrder ??
        source.sort_order
    ) ?? null;
  const parentLevel =
    toNonNegativeInteger(
      source.parentLevel ??
        source.parent_level ??
        source.parentUnitLevel ??
        source.parent_unit_level ??
        source.parentLevelNo ??
        source.parent_level_no
    ) ?? null;
  const quantityPerParentUnit =
    toPositiveNumber(
      source.quantityPerParentUnit ??
        source.quantity_per_parent_unit ??
        source.qtyPerParent ??
        source.qty_per_parent
    ) ??
    toPositiveNumber(numericHints?.quantityPerParentUnit) ??
    1;
  const quantityPerBaseUnit =
    toPositiveNumber(
      source.quantityPerBaseUnit ?? source.quantity_per_base_unit ?? source.qtyPerBase ?? source.qty_per_base
    ) ??
    toPositiveNumber(numericHints?.quantityPerBaseUnit) ??
    quantityPerParentUnit;
  const baseUnitCode = toAsciiToken(
    source.baseUnitCode ?? source.base_unit_code ?? defaultBaseUnitCode ?? unitTypeCode ?? "UNIT",
    "UNIT"
  );
  const unitTypeCodeToken = toAsciiToken(
    source.unitTypeCode ?? source.unit_type_code ?? unitTypeCode ?? "UNIT",
    "UNIT"
  );

  return {
    level,
    parentLevel,
    quantityPerParentUnit,
    quantityPerBaseUnit,
    baseUnitCode,
    unitTypeCode: unitTypeCodeToken,
  };
}

function buildSafeDisplayName(unitLabel, unitStructure) {
  const raw = normalizeWhitespace(unitLabel);
  if (raw && !hasCorruptedDisplayName(raw)) return raw;
  const qty = formatNumericToken(unitStructure?.quantityPerParentUnit, "1");
  return `1 unit = ${qty} base`;
}

function buildStableUnitCode(unitKey) {
  const hash = createHash("sha1").update(String(unitKey || "")).digest("hex").toUpperCase();
  return `${STABLE_UNIT_CODE_PREFIX}${hash}`.slice(0, STABLE_UNIT_CODE_LENGTH);
}

function getUnitKeyToken(unitKey, tokenName) {
  const text = normalizeText(unitKey);
  if (!text) return "";
  const pattern = new RegExp(`${tokenName}=([^|]+)`);
  const match = text.match(pattern);
  return match?.[1] ? String(match[1]).trim() : "";
}

function parseUnitKeyNumericToken(unitKey, tokenName) {
  const token = getUnitKeyToken(unitKey, tokenName);
  if (!token) return null;
  const numeric = Number(token);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
}

async function hasUnitKeyColumn(client) {
  if (hasUnitKeyColumnCache !== null) return hasUnitKeyColumnCache;
  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'product_unit_levels'
        AND column_name = 'unit_key'
      LIMIT 1
    `
  );
  hasUnitKeyColumnCache = Boolean(result.rows[0]);
  return hasUnitKeyColumnCache;
}

export async function hasProductUnitLevelsIsActiveColumn(client) {
  if (hasProductUnitLevelsIsActiveColumnCache === true) {
    return true;
  }

  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'product_unit_levels'
        AND column_name = 'is_active'
      LIMIT 1
    `
  );
  if (result.rows[0]) {
    hasProductUnitLevelsIsActiveColumnCache = true;
    return true;
  }

  return false;
}

export function productUnitLevelsIsActiveCompatExpression(alias = "pul") {
  const source = normalizeText(alias);
  if (!source) return "true";
  return `COALESCE((to_jsonb(${source}) ->> 'is_active')::boolean, true)`;
}

export function productUnitLevelsActiveCompatPredicate(alias = "pul") {
  return `${productUnitLevelsIsActiveCompatExpression(alias)} = true`;
}

export function productUnitLevelsInactiveCompatPredicate(alias = "pul") {
  return `${productUnitLevelsIsActiveCompatExpression(alias)} = false`;
}

export async function hasProductLotAllowedUnitLevelsTable(client) {
  if (hasProductLotAllowedUnitLevelsTableCache === true) {
    return true;
  }

  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'product_lot_allowed_unit_levels'
      LIMIT 1
    `
  );

  if (!result.rows[0]) {
    if (!lotWhitelistTableMissingWarningPrinted) {
      console.warn(
        "[lot-whitelist] product_lot_allowed_unit_levels is not deployed yet. Lot-specific whitelist behavior will stay on transitional fallback until migration 0017 is applied."
      );
      lotWhitelistTableMissingWarningPrinted = true;
    }
    return false;
  }

  const columnResult = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'product_lot_allowed_unit_levels'
        AND column_name = ANY($1::text[])
    `,
    [PRODUCT_LOT_ALLOWED_UNIT_LEVELS_REQUIRED_COLUMNS]
  );

  const presentColumns = new Set(columnResult.rows.map((row) => normalizeText(row.column_name)));
  const missingColumns = PRODUCT_LOT_ALLOWED_UNIT_LEVELS_REQUIRED_COLUMNS.filter(
    (columnName) => !presentColumns.has(columnName)
  );

  if (missingColumns.length) {
    if (!lotWhitelistTableIncompleteWarningPrinted) {
      console.warn(
        `[lot-whitelist] product_lot_allowed_unit_levels exists but is missing required columns: ${missingColumns.join(
          ", "
        )}. Treating the lot whitelist feature as unavailable until migration 0017 is fully applied.`
      );
      lotWhitelistTableIncompleteWarningPrinted = true;
    }
    return false;
  }

  hasProductLotAllowedUnitLevelsTableCache = true;
  return true;
}

export async function assertUnitLevelAllowedForLot(client, { productId, lotId, unitLevelId }) {
  const normalizedProductId = normalizeText(productId);
  const normalizedLotId = normalizeText(lotId);
  const normalizedUnitLevelId = normalizeText(unitLevelId);
  if (!normalizedProductId || !normalizedLotId || !normalizedUnitLevelId) {
    return;
  }
  if (!isUuid(normalizedLotId)) {
    throw httpError(400, "lotId must be a valid UUID");
  }
  if (!isUuid(normalizedUnitLevelId)) {
    throw httpError(400, "unitLevelId must be a valid UUID");
  }

  if (!(await hasProductLotAllowedUnitLevelsTable(client))) {
    return;
  }

  const activePredicate = productUnitLevelsActiveCompatPredicate("pul");
  const result = await client.query(
    `
      SELECT
        EXISTS (
          SELECT 1
          FROM product_lot_allowed_unit_levels plaul
          WHERE plaul.product_id = $1
            AND plaul.product_lot_id = $2
            AND plaul.is_active = true
        ) AS "hasWhitelist",
        EXISTS (
          SELECT 1
          FROM product_lot_allowed_unit_levels plaul
          JOIN product_unit_levels pul
            ON pul.id = plaul.unit_level_id
           AND pul.product_id = plaul.product_id
           AND ${activePredicate}
          WHERE plaul.product_id = $1
            AND plaul.product_lot_id = $2
            AND plaul.unit_level_id = $3
            AND plaul.is_active = true
        ) AS "isAllowed"
    `,
    [normalizedProductId, normalizedLotId, normalizedUnitLevelId]
  );

  const hasWhitelist = Boolean(result.rows[0]?.hasWhitelist);
  const isAllowed = Boolean(result.rows[0]?.isAllowed);

  // Transitional enforcement layer:
  // if the lot has no whitelist yet, keep current product-level fallback behavior.
  if (hasWhitelist && !isAllowed) {
    throw httpError(400, "unit not allowed for this lot");
  }
}

async function buildProductUnitContext(client, productId) {
  const activePredicate = productUnitLevelsActiveCompatPredicate("pul");
  const result = await client.query(
    `
      SELECT
        p.product_code AS "productCode",
        base_pul.sort_order AS "baseLevel",
        base_ut.code AS "baseUnitCode"
      FROM products p
      LEFT JOIN LATERAL (
        SELECT
          pul.sort_order,
          pul.unit_type_id
        FROM product_unit_levels pul
        WHERE pul.product_id = p.id
          AND ${activePredicate}
        ORDER BY pul.is_base DESC, pul.sort_order ASC, pul.created_at ASC
        LIMIT 1
      ) base_pul ON true
      LEFT JOIN unit_types base_ut ON base_ut.id = base_pul.unit_type_id
      WHERE p.id = $1
      LIMIT 1
    `,
    [productId]
  );

  if (!result.rows[0]) {
    throw httpError(404, `Product not found: ${productId}`);
  }

  return {
    productCode: result.rows[0].productCode || productId,
    baseLevel: toPositiveInteger(result.rows[0].baseLevel) ?? 1,
    baseUnitCode: result.rows[0].baseUnitCode || "UNIT",
  };
}

async function ensureUniqueProductUnitCode(client, productId, initialCode) {
  const baseCode = toAsciiToken(initialCode, `${STABLE_UNIT_CODE_PREFIX}FALLBACK`);
  let candidate = baseCode.slice(0, STABLE_UNIT_CODE_LENGTH);
  let suffix = 2;

  while (true) {
    const existing = await client.query(
      `
        SELECT 1
        FROM product_unit_levels
        WHERE product_id = $1
          AND code = $2
        LIMIT 1
      `,
      [productId, candidate]
    );
    if (!existing.rows[0]) return candidate;

    const suffixText = `_${suffix}`;
    candidate = `${baseCode.slice(0, STABLE_UNIT_CODE_LENGTH - suffixText.length)}${suffixText}`;
    suffix += 1;
    if (suffix > 9999) {
      throw httpError(500, "Unable to generate unique product unit level code");
    }
  }
}

export function buildUnitLevelKey({
  productCode,
  level,
  parentLevel,
  quantityPerParentUnit,
  quantityPerBaseUnit,
  baseUnitCode,
  unitTypeCode,
}) {
  const productToken = toAsciiToken(productCode, "UNKNOWN");
  const levelToken = String(toPositiveInteger(level) ?? 0);
  const parentToken = String(toNonNegativeInteger(parentLevel) ?? 0);
  const qppToken = formatNumericToken(quantityPerParentUnit, "1");
  const qpbToken = formatNumericToken(quantityPerBaseUnit, qppToken);
  const baseToken = toAsciiToken(baseUnitCode, "UNIT");
  const unitTypeToken = toAsciiToken(unitTypeCode, "UNIT");
  return `UL|product=${productToken}|lvl=${levelToken}|parent=${parentToken}|qpp=${qppToken}|qpb=${qpbToken}|base=${baseToken}|ut=${unitTypeToken}`;
}

export function getMovementBaseSign(movementType) {
  const normalized = String(movementType || "").trim().toUpperCase();
  if (normalized === "TRANSFER_OUT" || normalized === "DISPENSE") return -1;
  return 1;
}

export function getQuantityPerBaseFromUnitLevel(unitLevel) {
  const qpb =
    parseUnitKeyNumericToken(unitLevel?.unit_key, "qpb") ??
    parseUnitKeyNumericToken(unitLevel?.unitKey, "qpb");
  if (!qpb) {
    throw httpError(
      400,
      `unit_level_id ${unitLevel?.id || "-"} missing valid qpb conversion in unit_key`
    );
  }
  return qpb;
}

export function convertToBase(quantity, unitLevel) {
  const qty = toPositiveNumeric(quantity, "quantity");
  if (requiresWholeQuantity(unitLevel) && !Number.isInteger(qty)) {
    throw httpError(
      400,
      `quantity must be a whole number for ${normalizeWhitespace(unitLevel?.display_name || unitLevel?.code || "this unit")}`
    );
  }
  const qpb = getQuantityPerBaseFromUnitLevel(unitLevel);
  return qty * qpb;
}

export function convertMovementToSignedBase(quantity, movementType, unitLevel) {
  return convertToBase(quantity, unitLevel) * getMovementBaseSign(movementType);
}

export async function resolveProductBaseUnitLevel(client, productId) {
  const activePredicate = productUnitLevelsActiveCompatPredicate("product_unit_levels");
  const result = await client.query(
    `
      SELECT id, code, display_name, unit_key
      FROM product_unit_levels
      WHERE product_id = $1
        AND ${activePredicate}
      ORDER BY is_base DESC, sort_order ASC, created_at ASC
      LIMIT 1
    `,
    [productId]
  );
  if (!result.rows[0]) {
    throw httpError(400, `No unit level found for product ${productId}`);
  }
  if (!result.rows[0].unit_key || !getQuantityPerBaseFromUnitLevel(result.rows[0])) {
    throw httpError(400, `Base unit level for product ${productId} is missing valid unit_key`);
  }
  return result.rows[0];
}

export function toIsoTimestamp(value) {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw httpError(400, "Invalid datetime value");
    }
    return value.toISOString();
  }

  const normalized = String(value || "").trim();
  if (!normalized) return new Date().toISOString();

  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(normalized)) {
    const bangkokMatch = normalized.match(
      /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/
    );

    if (bangkokMatch) {
      const [, yearText, monthText, dayText, hourText, minuteText, secondText, millisecondText] =
        bangkokMatch;
      const year = Number(yearText);
      const month = Number(monthText);
      const day = Number(dayText);
      const hour = Number(hourText);
      const minute = Number(minuteText);
      const second = Number(secondText || 0);
      const millisecond = Number(String(millisecondText || "0").padEnd(3, "0").slice(0, 3));
      const utcMs = Date.UTC(year, month - 1, day, hour - 7, minute, second, millisecond);
      const bangkokValidation = new Date(utcMs + 7 * 60 * 60 * 1000);

      if (
        bangkokValidation.getUTCFullYear() !== year ||
        bangkokValidation.getUTCMonth() !== month - 1 ||
        bangkokValidation.getUTCDate() !== day ||
        bangkokValidation.getUTCHours() !== hour ||
        bangkokValidation.getUTCMinutes() !== minute ||
        bangkokValidation.getUTCSeconds() !== second
      ) {
        throw httpError(400, "Invalid datetime value");
      }

      return new Date(utcMs).toISOString();
    }
  }

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw httpError(400, "Invalid datetime value");
  }
  return date.toISOString();
}

export function toPositiveNumeric(value, fieldName) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    throw httpError(400, `${fieldName} must be a positive number`);
  }
  return numericValue;
}

export async function resolveBranchByCode(client, branchCode) {
  const code = String(branchCode || "").trim();
  if (!code) throw httpError(400, "branchCode is required");

  const result = await client.query(
    `
      SELECT id, code, name
      FROM locations
      WHERE code = $1
        AND location_type = 'BRANCH'
        AND is_active = true
      LIMIT 1
    `,
    [code]
  );

  if (!result.rows[0]) {
    throw httpError(404, `Branch not found: ${code}`);
  }

  return result.rows[0];
}

export async function resolveBranchById(client, branchId) {
  const id = String(branchId || "").trim();
  if (!id) throw httpError(400, "branch location id is required");

  const result = await client.query(
    `
      SELECT id, code, name
      FROM locations
      WHERE id = $1
        AND location_type = 'BRANCH'
        AND is_active = true
      LIMIT 1
    `,
    [id]
  );

  if (!result.rows[0]) {
    throw httpError(404, `Branch not found for location_id: ${id}`);
  }

  return result.rows[0];
}

export async function ensureProductExists(client, productId) {
  if (!productId) throw httpError(400, "productId is required");
  const result = await client.query(
    `
      SELECT id, trade_name
      FROM products
      WHERE id = $1
      LIMIT 1
    `,
    [productId]
  );

  if (!result.rows[0]) {
    throw httpError(404, `Product not found: ${productId}`);
  }

  return result.rows[0];
}

export async function resolveActorUserId(client, explicitUserId) {
  if (explicitUserId) {
    const existing = await client.query(
      `
        SELECT id
        FROM users
        WHERE id = $1
          AND is_active = true
        LIMIT 1
      `,
      [explicitUserId]
    );
    if (!existing.rows[0]) {
      throw httpError(404, `User not found: ${explicitUserId}`);
    }
    return existing.rows[0].id;
  }

  const existingSystem = await client.query(
    `
      SELECT id
      FROM users
      WHERE username = $1
      LIMIT 1
    `,
    [SYSTEM_USERNAME]
  );

  if (existingSystem.rows[0]) {
    return existingSystem.rows[0].id;
  }

  const created = await client.query(
    `
      INSERT INTO users (username, password_hash, full_name, role, is_active)
      VALUES ($1, $2, $3, 'ADMIN', true)
      RETURNING id
    `,
    [SYSTEM_USERNAME, DEFAULT_SYSTEM_PASSWORD_HASH, "System User"]
  );

  return created.rows[0].id;
}

export async function ensureUnitType(client, unitLabel) {
  const rawLabel = String(unitLabel || "").trim();
  if (!rawLabel) throw httpError(400, "unitLabel is required");
  const code = normalizeUnitCode(rawLabel);
  if (!code) throw httpError(400, "unitLabel is invalid");
  const safeSymbol = rawLabel.slice(0, 20);

  const existing = await client.query(
    `
      SELECT id, code
      FROM unit_types
      WHERE code = $1
      LIMIT 1
    `,
    [code]
  );

  if (existing.rows[0]) return existing.rows[0];

  const inserted = await client.query(
    `
      INSERT INTO unit_types (code, name_en, name_th, unit_kind, symbol, precision_scale, is_active)
      VALUES ($1, $2, $2, $3, $4, 3, true)
      RETURNING id, code
    `,
    [code, rawLabel, unitKindFromCode(code), safeSymbol]
  );

  return inserted.rows[0];
}

export async function ensureProductUnitLevel(client, productId, unitLabel, unitStructure = {}) {
  const explicitUnitLevelId = normalizeText(
    unitStructure?.unitLevelId ?? unitStructure?.unit_level_id
  );
  const activePredicate = productUnitLevelsActiveCompatPredicate("pul");
  const activePredicateWithoutAlias = productUnitLevelsActiveCompatPredicate("product_unit_levels");

  if (explicitUnitLevelId) {
    if (!isUuid(explicitUnitLevelId)) {
      throw httpError(400, "unitLevelId must be a valid UUID");
    }

    const byId = await client.query(
      `
        SELECT
          pul.id,
          pul.code,
          pul.unit_type_id,
          pul.unit_key,
          pul.display_name,
          pul.sort_order,
          ut.code AS unit_type_code
        FROM product_unit_levels pul
        LEFT JOIN unit_types ut ON ut.id = pul.unit_type_id
        WHERE pul.product_id = $1
          AND ${activePredicate}
          AND pul.id = $2::uuid
        LIMIT 1
      `,
      [productId, explicitUnitLevelId]
    );

    if (!byId.rows[0]) {
      throw httpError(404, `unitLevelId not found for product ${productId}`);
    }

    return byId.rows[0];
  }

  const normalizedUnitLabel = normalizeWhitespace(unitLabel);
  if (!normalizedUnitLabel) throw httpError(400, "unitLabel is required");
  const numericHints = extractNumericHintsFromLabel(normalizedUnitLabel);
  const supportsUnitKey = await hasUnitKeyColumn(client);

  if (!supportsUnitKey && !unitKeyLegacyWarningPrinted) {
    console.warn(
      "[unit-level] product_unit_levels.unit_key is missing. Run migration 0007_unit_level_code_stability.sql."
    );
    unitKeyLegacyWarningPrinted = true;
  }

  const byDisplayName = await client.query(
    `
      SELECT
        pul.id,
        pul.code,
        pul.unit_type_id,
        pul.unit_key,
        pul.display_name,
        pul.sort_order,
        ut.code AS unit_type_code
      FROM product_unit_levels pul
      LEFT JOIN unit_types ut ON ut.id = pul.unit_type_id
      WHERE pul.product_id = $1
        AND ${activePredicate}
        AND lower(trim(pul.display_name)) = lower(trim($2))
      ORDER BY pul.is_sellable DESC, pul.sort_order ASC, pul.created_at ASC
      LIMIT 1
    `,
    [productId, normalizedUnitLabel]
  );

  if (byDisplayName.rows[0]) {
    const existingByDisplay = byDisplayName.rows[0];
    if (supportsUnitKey && !existingByDisplay.unit_key) {
      const productContext = await buildProductUnitContext(client, productId);
      const normalizedStructure = normalizeUnitStructure(
        unitStructure,
        numericHints,
        productContext.baseUnitCode,
        existingByDisplay.unit_type_code || "UNIT"
      );
      const rowKey = buildUnitLevelKey({
        productCode: productContext.productCode,
        level: existingByDisplay.sort_order,
        parentLevel: normalizedStructure.parentLevel ?? Math.max(existingByDisplay.sort_order - 1, 0),
        quantityPerParentUnit: normalizedStructure.quantityPerParentUnit,
        quantityPerBaseUnit: normalizedStructure.quantityPerBaseUnit,
        baseUnitCode: normalizedStructure.baseUnitCode,
        unitTypeCode: normalizedStructure.unitTypeCode,
      });
      await client.query(
        `
          UPDATE product_unit_levels
          SET unit_key = COALESCE(unit_key, $2)
          WHERE id = $1
        `,
        [existingByDisplay.id, rowKey]
      );
      return {
        ...existingByDisplay,
        unit_key: rowKey,
      };
    }
    return existingByDisplay;
  }

  const unit = await ensureUnitType(client, normalizedUnitLabel);
  const productContext = await buildProductUnitContext(client, productId);
  const normalizedStructure = normalizeUnitStructure(
    unitStructure,
    numericHints,
    productContext.baseUnitCode,
    unit.code
  );

  if (supportsUnitKey && normalizedStructure.level !== null) {
    const structuralLookupKey = buildUnitLevelKey({
      productCode: productContext.productCode,
      level: normalizedStructure.level,
      parentLevel: normalizedStructure.parentLevel ?? 0,
      quantityPerParentUnit: normalizedStructure.quantityPerParentUnit,
      quantityPerBaseUnit: normalizedStructure.quantityPerBaseUnit,
      baseUnitCode: normalizedStructure.baseUnitCode,
      unitTypeCode: normalizedStructure.unitTypeCode,
    });
    const byUnitKey = await client.query(
      `
        SELECT id, code, unit_type_id, unit_key, display_name, sort_order
        FROM product_unit_levels
        WHERE product_id = $1
          AND ${activePredicateWithoutAlias}
          AND unit_key = $2
        LIMIT 1
      `,
      [productId, structuralLookupKey]
    );
    if (byUnitKey.rows[0]) return byUnitKey.rows[0];
  }

  const existingByLegacyCode = await client.query(
    `
      SELECT id, code, unit_type_id, unit_key, display_name, sort_order
      FROM product_unit_levels
      WHERE product_id = $1
        AND ${activePredicateWithoutAlias}
        AND code = $2
      ORDER BY sort_order ASC
      LIMIT 1
    `,
    [productId, unit.code]
  );

  if (existingByLegacyCode.rows[0]) {
    const existing = existingByLegacyCode.rows[0];
    const normalizedExistingDisplay = normalizeWhitespace(existing.display_name).toLowerCase();
    const normalizedIncomingDisplay = normalizeWhitespace(normalizedUnitLabel).toLowerCase();
    const hasLegacyCollision =
      supportsUnitKey &&
      normalizedExistingDisplay &&
      normalizedIncomingDisplay &&
      normalizedExistingDisplay !== normalizedIncomingDisplay &&
      !hasCorruptedDisplayName(existing.display_name);

    if (hasLegacyCollision) {
      console.warn(
        `[unit-level] legacy code collision detected for product_id=${productId} code=${existing.code}; ` +
          `existing="${existing.display_name}" incoming="${normalizedUnitLabel}". Inserting new row.`
      );
    } else {
      const patchedDisplayName =
        hasCorruptedDisplayName(existing.display_name) && !hasCorruptedDisplayName(normalizedUnitLabel)
          ? normalizedUnitLabel
          : existing.display_name;
      const nextUnitKey =
        supportsUnitKey && !existing.unit_key
          ? buildUnitLevelKey({
              productCode: productContext.productCode,
              level: existing.sort_order,
              parentLevel: normalizedStructure.parentLevel ?? Math.max(existing.sort_order - 1, 0),
              quantityPerParentUnit: normalizedStructure.quantityPerParentUnit,
              quantityPerBaseUnit: normalizedStructure.quantityPerBaseUnit,
              baseUnitCode: normalizedStructure.baseUnitCode,
              unitTypeCode: normalizedStructure.unitTypeCode,
            })
          : existing.unit_key;

      const shouldPatchDisplay = patchedDisplayName !== existing.display_name;
      const shouldPatchUnitKey = Boolean(supportsUnitKey && !existing.unit_key && nextUnitKey);
      if (shouldPatchDisplay || shouldPatchUnitKey) {
        const updates = [];
        const params = [existing.id];

        if (shouldPatchDisplay) {
          updates.push(`display_name = $${params.length + 1}`);
          params.push(patchedDisplayName);
        }
        if (shouldPatchUnitKey) {
          updates.push(`unit_key = $${params.length + 1}`);
          params.push(nextUnitKey);
        }

        const updated = await client.query(
          `
            UPDATE product_unit_levels
            SET ${updates.join(", ")}
            WHERE id = $1
            RETURNING id, code, unit_type_id, unit_key, display_name, sort_order
          `,
          params
        );
        console.warn(
          `[unit-level] patched legacy unit level id=${existing.id} product_id=${productId} ` +
            `display_fixed=${shouldPatchDisplay} unit_key_fixed=${shouldPatchUnitKey}`
        );
        return updated.rows[0];
      }

      return existing;
    }
  }

  const orderResult = await client.query(
    `
      SELECT
        COALESCE(MAX(sort_order), 0) AS max_order,
        COUNT(*)::int AS level_count
      FROM product_unit_levels
      WHERE product_id = $1
        AND ${activePredicateWithoutAlias}
    `,
    [productId]
  );
  const maxOrder = Number(orderResult.rows[0]?.max_order || 0);
  const levelCount = Number(orderResult.rows[0]?.level_count || 0);
  const isBase = levelCount === 0;
  let sortOrder = normalizedStructure.level ?? maxOrder + 1;
  if (!Number.isFinite(sortOrder) || sortOrder < 1) sortOrder = maxOrder + 1;

  const sortOrderConflict = await client.query(
    `
      SELECT 1
      FROM product_unit_levels
      WHERE product_id = $1
        AND ${activePredicateWithoutAlias}
        AND sort_order = $2
      LIMIT 1
    `,
    [productId, sortOrder]
  );
  if (sortOrderConflict.rows[0]) {
    sortOrder = maxOrder + 1;
  }

  const resolvedParentLevel =
    normalizedStructure.parentLevel !== null
      ? normalizedStructure.parentLevel
      : isBase
      ? 0
      : Math.max(sortOrder - 1, 0);
  const resolvedStructure = {
    ...normalizedStructure,
    level: sortOrder,
    parentLevel: resolvedParentLevel,
    quantityPerBaseUnit:
      normalizedStructure.quantityPerBaseUnit ?? normalizedStructure.quantityPerParentUnit,
  };
  const displayName = buildSafeDisplayName(normalizedUnitLabel, resolvedStructure);
  if (displayName !== normalizedUnitLabel) {
    console.warn(
      `[unit-level] normalized display label for product_id=${productId} from="${normalizedUnitLabel}" to="${displayName}"`
    );
  }

  if (supportsUnitKey) {
    const unitKey = buildUnitLevelKey({
      productCode: productContext.productCode,
      level: resolvedStructure.level,
      parentLevel: resolvedStructure.parentLevel,
      quantityPerParentUnit: resolvedStructure.quantityPerParentUnit,
      quantityPerBaseUnit: resolvedStructure.quantityPerBaseUnit,
      baseUnitCode: resolvedStructure.baseUnitCode,
      unitTypeCode: resolvedStructure.unitTypeCode,
    });
    const stableCode = await ensureUniqueProductUnitCode(client, productId, buildStableUnitCode(unitKey));

    const insertedWithKey = await client.query(
      `
        INSERT INTO product_unit_levels (
          product_id,
          code,
          unit_key,
          display_name,
          unit_type_id,
          is_base,
          is_sellable,
          sort_order
        )
        VALUES ($1, $2, $3, $4, $5, $6, true, $7)
        RETURNING id, code, unit_type_id, unit_key, display_name, sort_order
      `,
      [productId, stableCode, unitKey, displayName, unit.id, isBase, sortOrder]
    );
    return insertedWithKey.rows[0];
  }

  const insertedLegacy = await client.query(
    `
      INSERT INTO product_unit_levels (
        product_id,
        code,
        display_name,
        unit_type_id,
        is_base,
        is_sellable,
        sort_order
      )
      VALUES ($1, $2, $3, $4, $5, true, $6)
      RETURNING id, code, unit_type_id, display_name, sort_order
    `,
    [productId, unit.code, displayName, unit.id, isBase, sortOrder]
  );
  return insertedLegacy.rows[0];
}

export async function ensureLot(client, { productId, lotNo, mfgDate, expDate, manufacturer }) {
  const safeLotNo = String(lotNo || "").trim();
  if (!safeLotNo) throw httpError(400, "lotNo is required");
  if (!expDate) throw httpError(400, "expDate is required for receiving");

  const existing = await client.query(
    `
      SELECT id
      FROM product_lots
      WHERE product_id = $1
        AND lot_no = $2
        AND exp_date = $3::date
      LIMIT 1
    `,
    [productId, safeLotNo, expDate]
  );

  if (existing.rows[0]) return existing.rows[0].id;

  const inserted = await client.query(
    `
      INSERT INTO product_lots (
        product_id,
        lot_no,
        mfg_date,
        exp_date,
        manufacturer_name
      )
      VALUES ($1, $2, $3::date, $4::date, $5)
      RETURNING id
    `,
    [productId, safeLotNo, mfgDate || null, expDate, manufacturer || null]
  );

  return inserted.rows[0].id;
}

export async function assertLotBelongsToProduct(client, productId, lotId) {
  if (!lotId) return;
  const normalizedLotId = normalizeText(lotId);
  if (!isUuid(normalizedLotId)) {
    throw httpError(400, "lotId must be a valid UUID");
  }
  const result = await client.query(
    `
      SELECT id
      FROM product_lots
      WHERE id = $1
        AND product_id = $2
      LIMIT 1
    `,
    [normalizedLotId, productId]
  );

  if (!result.rows[0]) {
    throw httpError(400, `lotId ${normalizedLotId} does not belong to product ${productId}`);
  }
}

export async function applyStockDelta(
  client,
  { branchId, productId, lotId, baseUnitLevelId, deltaQtyBase }
) {
  if (!Number.isFinite(deltaQtyBase) || deltaQtyBase === 0) return;

  const existing = await client.query(
    `
      SELECT id, quantity_on_hand
      FROM stock_on_hand
      WHERE branch_id = $1
        AND product_id = $2
        AND base_unit_level_id = $3
        AND lot_id IS NOT DISTINCT FROM $4
      FOR UPDATE
    `,
    [branchId, productId, baseUnitLevelId, lotId || null]
  );

  if (!existing.rows[0]) {
    if (deltaQtyBase < 0) {
      throw httpError(400, "Insufficient stock for requested movement");
    }
    await client.query(
      `
        INSERT INTO stock_on_hand (
          branch_id,
          product_id,
          lot_id,
          base_unit_level_id,
          quantity_on_hand,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT (branch_id, product_id, lot_id, base_unit_level_id)
        DO UPDATE
        SET quantity_on_hand = stock_on_hand.quantity_on_hand + EXCLUDED.quantity_on_hand,
            updated_at = now()
      `,
      [branchId, productId, lotId || null, baseUnitLevelId, deltaQtyBase]
    );
    return;
  }

  const currentQty = Number(existing.rows[0].quantity_on_hand);
  const nextQty = currentQty + deltaQtyBase;

  if (nextQty < 0) {
    throw httpError(400, "Insufficient stock for requested movement");
  }

  await client.query(
    `
      UPDATE stock_on_hand
      SET quantity_on_hand = $2,
          updated_at = now()
      WHERE id = $1
    `,
    [existing.rows[0].id, nextQty]
  );
}

function normalizePidToken(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^0-9A-Za-z-]/g, "")
    .slice(0, 30);
}

function buildFallbackPid() {
  return `TEMP-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function normalizeDateInput(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export async function upsertPatientByPid(client, patient) {
  const patientInput = patient && typeof patient === "object" ? patient : {};
  const incomingPid = normalizePidToken(patientInput?.pid);
  const pid = incomingPid || buildFallbackPid();

  const existingByPid = await client.query(
    `
      SELECT
        full_name,
        birth_date,
        sex::text AS sex,
        card_issue_place,
        card_issued_date,
        card_expiry_date,
        address_raw_text,
        address_line1,
        district,
        province,
        postal_code
      FROM patients
      WHERE pid = $1
      LIMIT 1
    `,
    [pid]
  );
  const existing = existingByPid.rows[0] || null;

  const incomingFullName = String(
    patientInput?.fullName || patientInput?.full_name || patientInput?.name || ""
  ).trim();
  const fullName = incomingFullName || existing?.full_name || `ไม่ระบุชื่อ (${pid})`;

  const rawSex = String(patientInput?.sex || "").trim().toUpperCase();
  const normalizedSex =
    rawSex === "M" || rawSex === "MALE" || rawSex === "ชาย"
      ? "MALE"
      : rawSex === "F" || rawSex === "FEMALE" || rawSex === "หญิง"
      ? "FEMALE"
      : rawSex === "OTHER"
      ? "OTHER"
      : "UNKNOWN";
  const sex = rawSex ? normalizedSex : existing?.sex || "UNKNOWN";

  const birthDate =
    normalizeDateInput(patientInput?.birthDate || patientInput?.birth_date) ||
    existing?.birth_date ||
    null;
  const cardIssuedDate =
    normalizeDateInput(patientInput?.cardIssuedDate || patientInput?.card_issued_date) ||
    existing?.card_issued_date ||
    null;
  const cardExpiryDate =
    normalizeDateInput(patientInput?.cardExpiryDate || patientInput?.card_expiry_date) ||
    existing?.card_expiry_date ||
    null;
  const cardIssuePlace =
    String(patientInput?.cardIssuePlace || patientInput?.card_issue_place || "").trim() ||
    existing?.card_issue_place ||
    null;

  const addressRawText =
    String(patientInput?.addressText || patientInput?.address_raw_text || "").trim() ||
    existing?.address_raw_text ||
    null;
  const addressLine1 =
    String(patientInput?.addressLine1 || "").trim() ||
    addressRawText ||
    existing?.address_line1 ||
    null;
  const district =
    String(patientInput?.district || "").trim() || existing?.district || null;
  const province =
    String(patientInput?.province || "").trim() || existing?.province || null;
  const postalCode =
    String(patientInput?.postalCode || patientInput?.postal_code || "").trim() ||
    existing?.postal_code ||
    null;

  const result = await client.query(
    `
      INSERT INTO patients (
        pid,
        full_name,
        birth_date,
        sex,
        card_issue_place,
        card_issued_date,
        card_expiry_date,
        address_raw_text,
        address_line1,
        district,
        province,
        postal_code,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        COALESCE($4::sex_type, 'UNKNOWN'::sex_type),
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        now()
      )
      ON CONFLICT (pid)
      DO UPDATE SET
        full_name = EXCLUDED.full_name,
        birth_date = EXCLUDED.birth_date,
        sex = EXCLUDED.sex,
        card_issue_place = EXCLUDED.card_issue_place,
        card_issued_date = EXCLUDED.card_issued_date,
        card_expiry_date = EXCLUDED.card_expiry_date,
        address_raw_text = EXCLUDED.address_raw_text,
        address_line1 = EXCLUDED.address_line1,
        district = EXCLUDED.district,
        province = EXCLUDED.province,
        postal_code = EXCLUDED.postal_code,
      updated_at = now()
      RETURNING id
    `,
    [
      pid,
      fullName,
      birthDate,
      sex,
      cardIssuePlace,
      cardIssuedDate,
      cardExpiryDate,
      addressRawText,
      addressLine1,
      district,
      province,
      postalCode,
    ]
  );

  return result.rows[0].id;
}
