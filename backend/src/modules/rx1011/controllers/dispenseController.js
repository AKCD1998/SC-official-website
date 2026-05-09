import { query, withTransaction } from "../db/pool.js";
import {
  applyStockDelta,
  assertLotBelongsToProduct,
  assertUnitLevelAllowedForLot,
  convertToBase,
  ensureProductExists,
  ensureProductUnitLevel,
  resolveProductBaseUnitLevel,
  resolveActorUserId,
  resolveBranchById,
  resolveBranchByCode,
  toPositiveNumeric,
  upsertPatientByPid,
} from "./helpers.js";
import { httpError } from "../utils/httpError.js";

function toCleanText(value) {
  return String(value || "").trim();
}

function normalizeRole(value) {
  return toCleanText(value).toUpperCase();
}

function parsePositiveInteger(value, fallback, { min = 1, max = 100 } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const integerValue = Math.floor(numeric);
  if (integerValue < min) return min;
  if (integerValue > max) return max;
  return integerValue;
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

function normalizeOptionalTimestamp(value, label) {
  const text = toCleanText(value);
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw httpError(400, `Invalid ${label}`);
  }
  return parsed.toISOString();
}

function composeHeaderNote({ note, rawDeliverNotes, reportType, actionSource }) {
  const chunks = [];
  const mainNote = toCleanText(note);
  const rawNote = toCleanText(rawDeliverNotes);
  const normalizedReportType = toCleanText(reportType).toUpperCase();
  const normalizedActionSource = toCleanText(actionSource) || "DELIVER_PAGE_FINAL";

  if (mainNote) {
    chunks.push(mainNote);
  }
  if (rawNote && rawNote !== mainNote) {
    chunks.push(rawNote);
  }

  // TODO: move reportType/source to dedicated structured columns when schema adds them.
  const metadata = [`source=${normalizedActionSource}`];
  if (normalizedReportType) {
    metadata.push(`reportType=${normalizedReportType}`);
  }
  chunks.push(`[${metadata.join(" ")}]`);

  return chunks.join("\n\n").trim() || null;
}

function composeLineNote(line, fallbackReportType = "") {
  const lineNote = toCleanText(line?.note);
  const reportType = toCleanText(line?.reportType || fallbackReportType).toUpperCase();
  const lotNo = toCleanText(line?.lotNo);
  const metadata = [];

  if (reportType) metadata.push(`reportType=${reportType}`);
  if (lotNo) metadata.push(`lotNo=${lotNo}`);

  if (!lineNote && !metadata.length) return null;
  if (!metadata.length) return lineNote;
  if (!lineNote) return `[${metadata.join(" ")}]`;
  return `${lineNote}\n[${metadata.join(" ")}]`;
}

async function resolveLotIdForDispenseLine(client, { productId, lotIdInput, lotNoInput }) {
  // Preferred path: frontend sends canonical product_lots.id as lotId.
  const lotId = toCleanText(lotIdInput);
  if (lotId) return lotId;

  // Backward-compatible fallback for older clients that only send lotNo.
  const lotNo = toCleanText(lotNoInput);
  if (!lotNo) return null;

  const lotResult = await client.query(
    `
      SELECT id
      FROM product_lots
      WHERE product_id = $1
        AND lot_no = $2
      ORDER BY exp_date DESC
      LIMIT 1
    `,
    [productId, lotNo]
  );

  if (!lotResult.rows[0]) {
    throw httpError(400, `lotNo ${lotNo} does not exist for product ${productId}`);
  }

  return lotResult.rows[0].id;
}

async function assertReportGroupAllowedForProduct(client, { productId, reportType }) {
  const normalizedReportType = toCleanText(reportType).toUpperCase();
  if (!normalizedReportType) return;

  const result = await client.query(
    `
      SELECT 1
      FROM product_report_groups prg
      JOIN report_groups rg ON rg.id = prg.report_group_id
      WHERE prg.product_id = $1
        AND rg.code = $2
        AND rg.is_active = true
        AND prg.effective_from <= CURRENT_DATE
        AND (prg.effective_to IS NULL OR prg.effective_to > CURRENT_DATE)
      LIMIT 1
    `,
    [productId, normalizedReportType]
  );

  if (!result.rows[0]) {
    throw httpError(
      400,
      `reportType ${normalizedReportType} is not active for product ${productId}`
    );
  }
}

export async function createDispense(req, res) {
  const branchCodeInput = toCleanText(req.body?.branchCode);
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  const patient = req.body?.patient || {};
  const patientPid = toCleanText(patient?.pid);
  const patientFullName = toCleanText(patient?.fullName || patient?.full_name || patient?.name);
  const pharmacistUserIdInput = req.user?.id || req.body?.pharmacistUserId || null;
  const reportType = toCleanText(req.body?.reportType).toUpperCase();
  const actionSource = toCleanText(req.body?.actionSource) || "DELIVER_PAGE_FINAL";
  const requestedOccurredAt = normalizeOptionalTimestamp(
    req.body?.occurredAt ?? req.body?.dispensedAt,
    "occurredAt"
  );
  const occurredAt = actionSource === "DELIVER_PAGE_OFFLINE_SYNC" ? requestedOccurredAt : null;
  const note = composeHeaderNote({
    note: req.body?.note,
    rawDeliverNotes: req.body?.deliverNotesRaw,
    reportType,
    actionSource,
  });

  if (!lines.length) throw httpError(400, "lines must contain at least one item");
  if (!patientPid) {
    throw httpError(400, "patient.pid is required");
  }
  if (!patientFullName) {
    throw httpError(400, "patient.fullName is required");
  }

  const result = await withTransaction(async (client) => {
    const branch = branchCodeInput
      ? await resolveBranchByCode(client, branchCodeInput)
      : await resolveBranchById(client, req.user?.location_id);
    const pharmacistUserId = await resolveActorUserId(client, pharmacistUserIdInput);
    const patientId = await upsertPatientByPid(client, patient);

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
        VALUES ($1, $2, $3, COALESCE($5::timestamptz, now()), $4, $3, now(), now())
        RETURNING id, dispensed_at AS "dispensedAt"
      `,
      [branch.id, patientId, pharmacistUserId, note, occurredAt]
    );
    const headerId = headerResult.rows[0].id;
    const dispensedAt = headerResult.rows[0].dispensedAt;

    const insertedLines = [];
    let lineNo = 1;

    for (const line of lines) {
      const productId = toCleanText(line?.productId);
      const qty = toPositiveNumeric(line?.qty, "qty");
      const unitLabel = toCleanText(line?.unitLabel);
      const lineReportType = toCleanText(line?.reportType || reportType).toUpperCase();
      if (!unitLabel) throw httpError(400, "unitLabel is required");
      if (!productId) throw httpError(400, "productId is required");

      await ensureProductExists(client, productId);
      await assertReportGroupAllowedForProduct(client, {
        productId,
        reportType: lineReportType,
      });
      const unitLevel = await ensureProductUnitLevel(client, productId, unitLabel, line || {});
      const baseUnitLevel = await resolveProductBaseUnitLevel(client, productId);
      const quantityBase = convertToBase(qty, unitLevel);

      const lotId = await resolveLotIdForDispenseLine(client, {
        productId,
        lotIdInput: line?.lotId,
        lotNoInput: line?.lotNo,
      });
      if (lineReportType && !lotId) {
        throw httpError(400, `lotId or lotNo is required for ${lineReportType} dispense`);
      }
      if (lotId) {
        await assertLotBelongsToProduct(client, productId, lotId);
      }
      await assertUnitLevelAllowedForLot(client, {
        productId,
        lotId,
        unitLevelId: unitLevel.id,
      });
      const lineNote = composeLineNote(line, reportType);

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
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id
        `,
        [headerId, lineNo, productId, lotId, unitLevel.id, qty, lineNote]
      );
      const dispenseLineId = lineResult.rows[0].id;

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
            dispense_line_id,
            source_ref_type,
            source_ref_id,
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
            $7,
            'DISPENSE_HEADER',
            $8,
            COALESCE($11::timestamptz, now()),
            $9,
            $10
          )
        `,
        [
          branch.id,
          productId,
          lotId,
          qty,
          -quantityBase,
          unitLevel.id,
          dispenseLineId,
          headerId,
          pharmacistUserId,
          note,
          occurredAt,
        ]
      );

      await applyStockDelta(client, {
        branchId: branch.id,
        productId,
        lotId,
        baseUnitLevelId: baseUnitLevel.id,
        deltaQtyBase: -quantityBase,
      });

      insertedLines.push({
        id: dispenseLineId,
        lineNo,
        productId,
        lotId,
        quantity: qty,
        quantityBase: -quantityBase,
        unitLabel,
        reportType: lineReportType || null,
      });

      lineNo += 1;
    }

    return {
      headerId,
      branchCode: branch.code,
      patientId,
      dispensedAt,
      lineCount: insertedLines.length,
      lines: insertedLines,
      reportType: reportType || null,
      actionSource,
    };
  });

  return res.status(201).json({
    ok: true,
    ...result,
  });
}

export async function getPatientDispenseHistory(req, res) {
  const pid = String(req.params.pid || "").trim();
  if (!pid) throw httpError(400, "pid is required");

  const from = req.query.from ? new Date(String(req.query.from)) : null;
  const to = req.query.to ? new Date(String(req.query.to)) : null;
  if (from && Number.isNaN(from.getTime())) throw httpError(400, "Invalid from datetime");
  if (to && Number.isNaN(to.getTime())) throw httpError(400, "Invalid to datetime");

  const params = [pid];
  const where = ["pa.pid = $1"];

  if (from) {
    params.push(from.toISOString());
    where.push(`dh.dispensed_at >= $${params.length}::timestamptz`);
  }
  if (to) {
    params.push(to.toISOString());
    where.push(`dh.dispensed_at < $${params.length}::timestamptz`);
  }

  const result = await query(
    `
      SELECT
        dh.id AS "headerId",
        dh.dispensed_at AS "dispensedAt",
        pa.pid,
        pa.full_name AS "patientName",
        l.code AS "branchCode",
        l.name AS "branchName",
        p.id AS "productId",
        p.product_code AS "productCode",
        p.trade_name AS "tradeName",
        dl.quantity,
        pul.display_name AS "unitLabel",
        pl.lot_no AS "lotNo",
        dl.note_text AS "lineNote",
        dh.note_text AS "headerNote"
      FROM dispense_headers dh
      JOIN patients pa ON pa.id = dh.patient_id
      JOIN locations l ON l.id = dh.branch_id
      JOIN dispense_lines dl ON dl.header_id = dh.id
      JOIN products p ON p.id = dl.product_id
      JOIN product_unit_levels pul ON pul.id = dl.unit_level_id
      LEFT JOIN product_lots pl ON pl.id = dl.lot_id
      WHERE ${where.join(" AND ")}
      ORDER BY dh.dispensed_at DESC, dl.line_no
      LIMIT 1000
    `,
    params
  );

  return res.json(result.rows);
}

export async function listDispenseHistory(req, res) {
  const userRole = normalizeRole(req.user?.role);
  const branchLocationId = toCleanText(req.user?.location_id);
  const q = toCleanText(req.query.q);
  const pid = toCleanText(req.query.pid);
  const patientName = toCleanText(req.query.patientName || req.query.patient_name);
  const branchCode = toCleanText(req.query.branchCode || req.query.branch_code);
  const productName = toCleanText(req.query.productName || req.query.product_name);
  const lotNo = toCleanText(req.query.lotNo || req.query.lot_no);
  const dateFrom = normalizeDateFilter(req.query.dateFrom || req.query.date_from, "dateFrom");
  const dateTo = normalizeDateFilter(req.query.dateTo || req.query.date_to, "dateTo");
  const page = parsePositiveInteger(req.query.page, 1, { min: 1, max: 100000 });
  const limit = parsePositiveInteger(req.query.limit, 20, { min: 1, max: 100 });
  const offset = (page - 1) * limit;

  const params = [];
  const where = [];

  if (userRole === "PHARMACIST") {
    if (!branchLocationId) {
      throw httpError(403, "Branch-scoped access requires location_id");
    }
    params.push(branchLocationId);
    where.push(`dh.branch_id = $${params.length}`);
  }

  if (q) {
    params.push(`%${q}%`);
    const placeholder = `$${params.length}`;
    where.push(`
      (
        pa.pid ILIKE ${placeholder}
        OR pa.full_name ILIKE ${placeholder}
        OR COALESCE(l.code, '') ILIKE ${placeholder}
        OR COALESCE(l.name, '') ILIKE ${placeholder}
        OR COALESCE(p.trade_name, '') ILIKE ${placeholder}
        OR COALESCE(p.product_code, '') ILIKE ${placeholder}
        OR COALESCE(pl.lot_no, '') ILIKE ${placeholder}
        OR COALESCE(ph.full_name, '') ILIKE ${placeholder}
        OR COALESCE(ph.username, '') ILIKE ${placeholder}
      )
    `);
  }

  if (pid) {
    params.push(`%${pid}%`);
    where.push(`pa.pid ILIKE $${params.length}`);
  }

  if (patientName) {
    params.push(`%${patientName}%`);
    where.push(`pa.full_name ILIKE $${params.length}`);
  }

  if (branchCode) {
    params.push(branchCode);
    where.push(`l.code = $${params.length}`);
  }

  if (productName) {
    params.push(`%${productName}%`);
    const placeholder = `$${params.length}`;
    where.push(`
      (
        COALESCE(p.trade_name, '') ILIKE ${placeholder}
        OR COALESCE(p.product_code, '') ILIKE ${placeholder}
      )
    `);
  }

  if (lotNo) {
    params.push(`%${lotNo}%`);
    where.push(`COALESCE(pl.lot_no, '') ILIKE $${params.length}`);
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

  const fromSql = `
    FROM dispense_headers dh
    JOIN patients pa ON pa.id = dh.patient_id
    JOIN locations l ON l.id = dh.branch_id
    LEFT JOIN users ph ON ph.id = dh.pharmacist_user_id
    JOIN dispense_lines dl ON dl.header_id = dh.id
    JOIN products p ON p.id = dl.product_id
    JOIN product_unit_levels pul ON pul.id = dl.unit_level_id
    LEFT JOIN product_lots pl ON pl.id = dl.lot_id
  `;
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalResult = await query(
    `
      SELECT COUNT(*)::int AS total
      ${fromSql}
      ${whereSql}
    `,
    params
  );
  const total = Number(totalResult.rows[0]?.total || 0);

  const dataParams = [...params, limit, offset];
  const limitPlaceholder = `$${params.length + 1}`;
  const offsetPlaceholder = `$${params.length + 2}`;
  const result = await query(
    `
      SELECT
        dh.id AS "headerId",
        dl.id AS "lineId",
        dl.line_no AS "lineNo",
        dh.dispensed_at AS "dispensedAt",
        pa.pid,
        pa.full_name AS "patientName",
        pa.birth_date AS "birthDate",
        pa.sex::text AS sex,
        pa.card_issue_place AS "cardIssuePlace",
        pa.card_issued_date AS "cardIssuedDate",
        pa.card_expiry_date AS "cardExpiryDate",
        COALESCE(pa.address_raw_text, pa.address_line1) AS "addressText",
        l.id AS "branchId",
        l.code AS "branchCode",
        l.name AS "branchName",
        COALESCE(ph.full_name, ph.username) AS "pharmacistName",
        ph.username AS "pharmacistUsername",
        p.id AS "productId",
        p.product_code AS "productCode",
        p.trade_name AS "tradeName",
        dl.quantity,
        pul.display_name AS "unitLabel",
        pl.lot_no AS "lotNo",
        dl.note_text AS "lineNote",
        dh.note_text AS "headerNote"
      ${fromSql}
      ${whereSql}
      ORDER BY dh.dispensed_at DESC, dh.id DESC, dl.line_no ASC
      LIMIT ${limitPlaceholder}
      OFFSET ${offsetPlaceholder}
    `,
    dataParams
  );

  return res.json({
    items: result.rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: total > 0 ? Math.ceil(total / limit) : 0,
    },
  });
}
