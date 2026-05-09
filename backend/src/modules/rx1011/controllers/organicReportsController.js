import { query } from "../db/pool.js";
import { httpError } from "../utils/httpError.js";

function toCleanText(value) {
  return String(value || "").trim();
}

function normalizeRole(value) {
  return toCleanText(value).toUpperCase();
}

function isDateOnlyToken(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function normalizeDateFilter(value, label) {
  const text = toCleanText(value);
  if (!text) return null;

  if (isDateOnlyToken(text)) {
    const parsed = new Date(`${text}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw httpError(400, `Invalid ${label}`);
    }
    return {
      value: text,
      type: "date",
    };
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw httpError(400, `Invalid ${label}`);
  }

  return {
    value: parsed.toISOString(),
    type: "timestamp",
  };
}

function buildReportTitle(reportGroupCode) {
  const normalizedCode = toCleanText(reportGroupCode).toUpperCase();
  if (normalizedCode === "KY10") {
    return "บัญชีการขายยาควบคุมพิเศษ เฉพาะรายการยาที่เลขาธิการคณะกรรมการอาหารและยากำหนด";
  }
  return "บัญชีการขายยาอันตราย เฉพาะรายการยาที่เลขาธิการคณะกรรมการอาหารและยากำหนด";
}

function formatQuantityText(quantity, unitLabel) {
  const numeric = Number(quantity);
  const safeUnitLabel =
    extractPackagingContainerLabel(unitLabel) || toCleanText(unitLabel) || "unit";
  if (!Number.isFinite(numeric)) {
    return safeUnitLabel;
  }

  const whole = Math.abs(numeric - Math.trunc(numeric)) < 0.0001;
  const formatted = whole
    ? Math.trunc(numeric).toLocaleString("th-TH")
    : numeric.toLocaleString("th-TH", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 4,
      });
  return `${formatted} ${safeUnitLabel}`;
}

function isStripUnitLabel(unitLabel) {
  const normalized = toCleanText(unitLabel).toLowerCase();
  return normalized.includes("แผง") || /\bstrips?\b/u.test(normalized);
}

function splitDispenseReportQuantities(quantity, unitLabel) {
  const numeric = Number(quantity);
  if (
    !Number.isFinite(numeric) ||
    !Number.isInteger(numeric) ||
    numeric <= 2 ||
    !isStripUnitLabel(unitLabel)
  ) {
    return [numeric];
  }

  const chunks = [];
  let remaining = numeric;
  while (remaining > 2) {
    chunks.push(2);
    remaining -= 2;
  }
  if (remaining > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

function extractPackagingContainerLabel(unitLabel) {
  const normalized = toCleanText(unitLabel).replace(/\s+/g, " ");
  if (!normalized) return "";
  const firstPart = normalized.split(/\s*[xX×]\s*/u)[0] || "";
  const containerMatch = firstPart.match(/^1\s+(.+)$/u);
  return String(containerMatch?.[1] || firstPart).trim();
}

function inferQuantityPerBase(unitLabel, isBase) {
  if (isBase) return 1;
  const matches = [...String(unitLabel || "").matchAll(/[0-9]+(?:\.[0-9]+)?/g)].map((entry) =>
    Number(entry[0])
  );
  if (matches.length >= 2) return matches[1];
  if (matches.length === 1) return matches[0];
  return 1;
}

function resolveQuantityPerBase(value, unitLabel, isBase) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  return inferQuantityPerBase(unitLabel, isBase);
}

const REPORT_METADATA_TAG_PATTERN =
  /\[(?:[^\]]*?(?:reportType|source|lotNo|incidentCode|actionType)=[^\]]*?)\]/gi;

const INCIDENT_REPORT_NOTE_PATTERN =
  /\bINC-\d{6,}\b|incidentCode\s*=|source\s*=\s*INCIDENT_RESOLUTION|actionType\s*=\s*RETROSPECTIVE_DISPENSE|(?:สร้าง)?ย้อนหลังจาก\s*incident/iu;

const RECIPIENT_PROFILE_LABELS = [
  "ผู้รับมอบยา",
  "ชื่อผู้รับมอบยา",
  "เลขประจำตัวประชาชน",
  "ชื่อภาษาอังกฤษ",
  "วันเกิด",
  "เพศ",
  "ที่อยู่",
];

const RECIPIENT_PROFILE_PATTERN = new RegExp(
  `(?:${RECIPIENT_PROFILE_LABELS.join("|")})\\s*:\\s*[\\s\\S]*?(?=(?:${RECIPIENT_PROFILE_LABELS.join(
    "|"
  )})\\s*:|$)`,
  "g"
);

function normalizeInlineWhitespace(value) {
  return toCleanText(value).replace(/\s+/g, " ");
}

function sanitizeReportNoteText(value) {
  let text = toCleanText(value);
  if (!text) return "";
  if (INCIDENT_REPORT_NOTE_PATTERN.test(text)) return "";

  text = text.replace(REPORT_METADATA_TAG_PATTERN, " ");
  text = text.replace(RECIPIENT_PROFILE_PATTERN, " ");

  const parts = text
    .split("|")
    .map((part) => normalizeInlineWhitespace(part))
    .filter(Boolean);

  return parts.join(" | ");
}

function combineNotes(...values) {
  const unique = [];

  for (const value of values) {
    const cleaned = sanitizeReportNoteText(value);
    if (!cleaned || unique.includes(cleaned)) continue;
    unique.push(cleaned);
  }

  return unique.join(" | ");
}

async function resolveAccessibleBranch(requestedBranchCode, user) {
  const role = normalizeRole(user?.role);
  const normalizedRequestedBranchCode = toCleanText(requestedBranchCode);

  if (role === "ADMIN") {
    if (!normalizedRequestedBranchCode) {
      throw httpError(400, "branchCode is required");
    }

    const result = await query(
      `
        SELECT
          id,
          code,
          name
        FROM locations
        WHERE code = $1
          AND location_type = 'BRANCH'
          AND is_active = true
        LIMIT 1
      `,
      [normalizedRequestedBranchCode]
    );

    const branch = result.rows[0];
    if (!branch) {
      throw httpError(404, "Branch not found");
    }
    return branch;
  }

  const locationId = toCleanText(user?.location_id);
  if (!locationId) {
    throw httpError(403, "Branch-scoped access requires location_id");
  }

  const result = await query(
    `
      SELECT
        id,
        code,
        name
      FROM locations
      WHERE id = $1::uuid
        AND location_type = 'BRANCH'
        AND is_active = true
      LIMIT 1
    `,
    [locationId]
  );

  const branch = result.rows[0];
  if (!branch) {
    throw httpError(403, "User branch is not found");
  }

  if (normalizedRequestedBranchCode && normalizedRequestedBranchCode !== branch.code) {
    throw httpError(403, "Branch access denied");
  }

  return branch;
}

async function getProductMeta(productId) {
  const result = await query(
    `
      SELECT
        p.id AS "productId",
        p.product_code AS "productCode",
        p.trade_name AS "tradeName",
        mloc.name AS "manufacturerName",
        COALESCE(NULLIF(trim(sellable_pul.display_name), ''), sellable_pul.code, '-') AS "packageSize",
        report_pul.id AS "reportReceiveUnitLevelId",
        COALESCE(NULLIF(trim(report_pul.display_name), ''), NULLIF(trim(sellable_pul.display_name), ''), sellable_pul.code, '-') AS "reportReceiveUnitLabel",
        CASE
          WHEN report_pul.id IS NOT NULL
            THEN NULLIF((regexp_match(COALESCE(report_pul.unit_key, ''), 'qpb=([0-9]+(?:\\.[0-9]+)?)'))[1], '')::numeric
          ELSE NULLIF((regexp_match(COALESCE(sellable_pul.unit_key, ''), 'qpb=([0-9]+(?:\\.[0-9]+)?)'))[1], '')::numeric
        END AS "reportReceiveUnitQuantityPerBase",
        CASE
          WHEN report_pul.id IS NOT NULL THEN report_pul.is_base
          ELSE COALESCE(sellable_pul.is_base, false)
        END AS "reportReceiveUnitIsBase"
      FROM products p
      LEFT JOIN locations mloc ON mloc.id = p.manufacturer_location_id
      LEFT JOIN LATERAL (
        SELECT
          pul.id::text AS id,
          pul.display_name,
          pul.code,
          pul.unit_key,
          pul.is_base
        FROM product_unit_levels pul
        WHERE pul.id = p.report_receive_unit_level_id
        LIMIT 1
      ) report_pul ON true
      LEFT JOIN LATERAL (
        SELECT
          pul.display_name,
          pul.code,
          pul.unit_key,
          pul.is_base
        FROM product_unit_levels pul
        WHERE pul.product_id = p.id
        ORDER BY pul.is_sellable DESC, pul.is_base DESC, pul.sort_order ASC, pul.created_at ASC
        LIMIT 1
      ) sellable_pul ON true
      WHERE p.id = $1::uuid
      LIMIT 1
    `,
    [productId]
  );

  const product = result.rows[0];
  if (!product) {
    throw httpError(404, "Product not found");
  }

  return product;
}

export async function getOrganicDispenseLedgerActivityProducts(req, res) {
  const branchCode = toCleanText(req.query.branchCode || req.query.branch_code);
  const reportGroupCode = toCleanText(req.query.reportGroupCode || req.query.report_group_code).toUpperCase();
  const dateFrom = normalizeDateFilter(req.query.dateFrom || req.query.date_from, "dateFrom");
  const dateTo = normalizeDateFilter(req.query.dateTo || req.query.date_to, "dateTo");

  if (!reportGroupCode) {
    throw httpError(400, "reportGroupCode is required");
  }

  const branch = await resolveAccessibleBranch(branchCode, req.user);
  const params = [branch.id, reportGroupCode];
  const where = [
    "dh.branch_id = $1::uuid",
    `
      EXISTS (
        SELECT 1
        FROM product_report_groups prg
        JOIN report_groups rg ON rg.id = prg.report_group_id
        WHERE prg.product_id = dl.product_id
          AND rg.code = $2
          AND rg.is_active = true
          AND prg.effective_from <= dh.dispensed_at::date
          AND (prg.effective_to IS NULL OR prg.effective_to >= dh.dispensed_at::date)
      )
    `,
  ];

  if (dateFrom) {
    params.push(dateFrom.value);
    where.push(
      dateFrom.type === "date"
        ? `dh.dispensed_at >= $${params.length}::date`
        : `dh.dispensed_at >= $${params.length}::timestamptz`
    );
  }

  if (dateTo) {
    params.push(dateTo.value);
    where.push(
      dateTo.type === "date"
        ? `dh.dispensed_at < ($${params.length}::date + interval '1 day')`
        : `dh.dispensed_at < $${params.length}::timestamptz`
    );
  }

  const result = await query(
    `
      SELECT
        p.id::text AS id,
        p.id::text AS "productId",
        p.product_code AS "productCode",
        p.trade_name AS "tradeName",
        COALESCE(
          NULLIF(trim(report_pul.display_name), ''),
          NULLIF(trim(sellable_pul.display_name), ''),
          sellable_pul.code,
          '-'
        ) AS "packageSize",
        COALESCE(
          NULLIF(trim(report_pul.display_name), ''),
          NULLIF(trim(sellable_pul.display_name), ''),
          sellable_pul.code,
          '-'
        ) AS "reportReceiveUnitLabel",
        COUNT(DISTINCT dl.id)::int AS "activityCount",
        COUNT(DISTINCT dl.lot_id) FILTER (WHERE dl.lot_id IS NOT NULL)::int AS "lotCount",
        MIN(dh.dispensed_at) AS "firstDispensedAt",
        MAX(dh.dispensed_at) AS "lastDispensedAt"
      FROM dispense_headers dh
      JOIN dispense_lines dl ON dl.header_id = dh.id
      JOIN products p ON p.id = dl.product_id
      LEFT JOIN LATERAL (
        SELECT
          pul.display_name,
          pul.code
        FROM product_unit_levels pul
        WHERE pul.id = p.report_receive_unit_level_id
        LIMIT 1
      ) report_pul ON true
      LEFT JOIN LATERAL (
        SELECT
          pul.display_name,
          pul.code
        FROM product_unit_levels pul
        WHERE pul.product_id = p.id
        ORDER BY pul.is_sellable DESC, pul.is_base DESC, pul.sort_order ASC, pul.created_at ASC
        LIMIT 1
      ) sellable_pul ON true
      WHERE ${where.join(" AND ")}
      GROUP BY
        p.id,
        p.product_code,
        p.trade_name,
        report_pul.display_name,
        report_pul.code,
        sellable_pul.display_name,
        sellable_pul.code
      ORDER BY p.trade_name ASC, p.product_code ASC
    `,
    params
  );

  return res.json({
    items: result.rows.map((row) => ({
      ...row,
      branchCode: toCleanText(branch.code),
      branchName: toCleanText(branch.name) || "-",
      reportGroupCode,
      activityCount: Number(row.activityCount || 0),
      lotCount: Number(row.lotCount || 0),
    })),
  });
}

export async function getOrganicDispenseLedgerReport(req, res) {
  const branchCode = toCleanText(req.query.branchCode || req.query.branch_code);
  const productId = toCleanText(req.query.productId || req.query.product_id);
  const reportGroupCode = toCleanText(req.query.reportGroupCode || req.query.report_group_code).toUpperCase();
  const lotId = toCleanText(req.query.lotId || req.query.lot_id);
  const dateFrom = normalizeDateFilter(req.query.dateFrom || req.query.date_from, "dateFrom");
  const dateTo = normalizeDateFilter(req.query.dateTo || req.query.date_to, "dateTo");

  if (!productId) {
    throw httpError(400, "productId is required");
  }

  const branch = await resolveAccessibleBranch(branchCode, req.user);
  const product = await getProductMeta(productId);

  const params = [branch.id, productId];
  const where = ["dh.branch_id = $1::uuid", "dl.product_id = $2::uuid"];

  if (lotId) {
    params.push(lotId);
    where.push(`dl.lot_id = $${params.length}::uuid`);
  }

  if (dateFrom) {
    params.push(dateFrom.value);
    where.push(
      dateFrom.type === "date"
        ? `dh.dispensed_at >= $${params.length}::date`
        : `dh.dispensed_at >= $${params.length}::timestamptz`
    );
  }

  if (dateTo) {
    params.push(dateTo.value);
    where.push(
      dateTo.type === "date"
        ? `dh.dispensed_at < ($${params.length}::date + interval '1 day')`
        : `dh.dispensed_at < $${params.length}::timestamptz`
    );
  }

  const dispenseResult = await query(
    `
      SELECT
        dh.dispensed_at AS "dispensedAt",
        pa.pid,
        pa.full_name AS "patientName",
        COALESCE(ph.full_name, ph.username, '') AS "pharmacistName",
        dl.quantity,
        COALESCE(NULLIF(trim(pul.display_name), ''), pul.code, 'unit') AS "unitLabel",
        pl.id AS "lotId",
        pl.lot_no AS "lotNo",
        dl.note_text AS "lineNote",
        dh.note_text AS "headerNote"
      FROM dispense_headers dh
      JOIN patients pa ON pa.id = dh.patient_id
      LEFT JOIN users ph ON ph.id = dh.pharmacist_user_id
      JOIN dispense_lines dl ON dl.header_id = dh.id
      JOIN product_unit_levels pul ON pul.id = dl.unit_level_id
      LEFT JOIN product_lots pl ON pl.id = dl.lot_id
      WHERE ${where.join(" AND ")}
      ORDER BY COALESCE(pl.lot_no, '') ASC, dh.dispensed_at ASC, dh.id ASC, dl.line_no ASC
    `,
    params
  );

  const dispenseRows = Array.isArray(dispenseResult.rows) ? dispenseResult.rows : [];
  const lotIds = [...new Set(dispenseRows.map((row) => toCleanText(row.lotId)).filter(Boolean))];

  const receiveSummaryByLotId = new Map();

  if (lotIds.length) {
    const receiveParams = [branch.id, productId, lotIds];

    const receiveMetaResult = await query(
      `
        SELECT
          sm.lot_id AS "lotId",
          MIN(COALESCE(sm.corrected_occurred_at, sm.occurred_at)) AS "receivedAt",
          STRING_AGG(
            DISTINCT COALESCE(NULLIF(trim(from_l.name), ''), NULLIF(trim(from_l.code), ''), '-'),
            ', '
          ) AS "sourceName"
        FROM stock_movements sm
        LEFT JOIN locations from_l ON from_l.id = sm.from_location_id
        WHERE sm.movement_type IN ('RECEIVE', 'TRANSFER_IN')
          AND sm.to_location_id = $1::uuid
          AND sm.product_id = $2::uuid
          AND sm.lot_id = ANY($3::uuid[])
        GROUP BY sm.lot_id
      `,
      receiveParams
    );

    const receiveQtyResult = await query(
      `
        SELECT
          sm.lot_id AS "lotId",
          pul.id::text AS "unitLevelId",
          COALESCE(NULLIF(trim(pul.display_name), ''), pul.code, 'unit') AS "unitLabel",
          pul.is_base AS "isBase",
          NULLIF((regexp_match(COALESCE(pul.unit_key, ''), 'qpb=([0-9]+(?:\\.[0-9]+)?)'))[1], '')::numeric AS "quantityPerBase",
          SUM(sm.quantity) AS quantity
        FROM stock_movements sm
        JOIN product_unit_levels pul ON pul.id = sm.unit_level_id
        WHERE sm.movement_type IN ('RECEIVE', 'TRANSFER_IN')
          AND sm.to_location_id = $1::uuid
          AND sm.product_id = $2::uuid
          AND sm.lot_id = ANY($3::uuid[])
        GROUP BY
          sm.lot_id,
          pul.id,
          COALESCE(NULLIF(trim(pul.display_name), ''), pul.code, 'unit'),
          pul.is_base,
          NULLIF((regexp_match(COALESCE(pul.unit_key, ''), 'qpb=([0-9]+(?:\\.[0-9]+)?)'))[1], '')::numeric
      `,
      receiveParams
    );

    for (const row of receiveMetaResult.rows) {
      receiveSummaryByLotId.set(toCleanText(row.lotId), {
        receivedAt: row.receivedAt || null,
        sourceName: toCleanText(row.sourceName) || "-",
        receivedQuantityText: "-",
      });
    }

    const reportReceiveUnitLabel =
      extractPackagingContainerLabel(product.reportReceiveUnitLabel) ||
      toCleanText(product.reportReceiveUnitLabel) ||
      "unit";
    const reportReceiveUnitQuantityPerBase = resolveQuantityPerBase(
      product.reportReceiveUnitQuantityPerBase,
      product.reportReceiveUnitLabel,
      product.reportReceiveUnitIsBase
    );
    const receivedBaseQuantityByLotId = new Map();

    for (const row of receiveQtyResult.rows) {
      const key = toCleanText(row.lotId);
      const quantity = Number(row.quantity || 0);
      const sourceQuantityPerBase = resolveQuantityPerBase(row.quantityPerBase, row.unitLabel, row.isBase);
      const nextBaseQuantity = (receivedBaseQuantityByLotId.get(key) || 0) + quantity * sourceQuantityPerBase;
      receivedBaseQuantityByLotId.set(key, nextBaseQuantity);
    }

    for (const [key, totalBaseQuantity] of receivedBaseQuantityByLotId.entries()) {
      const current = receiveSummaryByLotId.get(key) || {
        receivedAt: null,
        sourceName: "-",
        receivedQuantityText: "-",
      };
      current.receivedQuantityText = formatQuantityText(
        totalBaseQuantity / reportReceiveUnitQuantityPerBase,
        reportReceiveUnitLabel
      );
      receiveSummaryByLotId.set(key, current);
    }
  }

  const pagesByLotKey = new Map();

  for (const row of dispenseRows) {
    const normalizedLotId = toCleanText(row.lotId);
    const lotKey = normalizedLotId || "__UNSPECIFIED_LOT__";
    const lotSummary = receiveSummaryByLotId.get(normalizedLotId) || null;
    const existingPage = pagesByLotKey.get(lotKey);

    if (!existingPage) {
      pagesByLotKey.set(lotKey, {
        lot: {
          id: normalizedLotId,
          batch: toCleanText(row.lotNo) || "ไม่ระบุ lot",
          date: lotSummary?.receivedAt || null,
          receivedQuantityText: lotSummary?.receivedQuantityText || "-",
          sourceName: lotSummary?.sourceName || "-",
        },
        rows: [],
      });
    }

    const unitLabel = toCleanText(row.unitLabel) || "unit";
    const reportQuantities = splitDispenseReportQuantities(row.quantity, unitLabel);
    const note = combineNotes(row.lineNote, row.headerNote);

    for (const reportQuantity of reportQuantities) {
      pagesByLotKey.get(lotKey).rows.push({
        date: row.dispensedAt,
        qty: reportQuantity,
        qtyText: formatQuantityText(reportQuantity, unitLabel),
        unitLabel,
        name: toCleanText(row.patientName) || "-",
        pid: toCleanText(row.pid) || "-",
        pharmacistName: toCleanText(row.pharmacistName) || "",
        note,
      });
    }
  }

  const pages = [...pagesByLotKey.values()].sort((left, right) => {
    const leftTime = left?.lot?.date ? new Date(left.lot.date).getTime() : Number.MAX_SAFE_INTEGER;
    const rightTime = right?.lot?.date ? new Date(right.lot.date).getTime() : Number.MAX_SAFE_INTEGER;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return String(left?.lot?.batch || "").localeCompare(String(right?.lot?.batch || ""), "th");
  });

  return res.json({
    meta: {
      reportTitle: buildReportTitle(reportGroupCode),
      reportGroupCode: reportGroupCode || null,
      branchCode: toCleanText(branch.code),
      branchNameOnly: toCleanText(branch.name) || "-",
      branchLabel: `${toCleanText(branch.code) || "-"} : ${toCleanText(branch.name) || "-"}`,
      productId: toCleanText(product.productId),
      productCode: toCleanText(product.productCode),
      product: toCleanText(product.tradeName) || "-",
      packSize: toCleanText(product.packageSize) || "-",
      reportReceiveUnitLabel:
        extractPackagingContainerLabel(product.reportReceiveUnitLabel) ||
        toCleanText(product.reportReceiveUnitLabel) ||
        "-",
      maker: toCleanText(product.manufacturerName) || "-",
    },
    pages,
  });
}
