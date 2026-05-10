import { query } from '../db.js';
import {
  buildLiffReceiptPromoBookingOption,
  isLiffReceiptPromoActive,
  isLiffReceiptPromoChannel,
  LIFF_RECEIPT_PROMO_ACTIVE_FROM,
  LIFF_RECEIPT_PROMO_ACTIVE_UNTIL,
  LIFF_RECEIPT_PROMO_BOOKING_CHANNEL,
  LIFF_RECEIPT_PROMO_TREATMENT_CODE,
} from '../config/liffReceiptPromoCampaign.js';
import {
  APPOINTMENT_IDENTITY_JOINS_SQL,
  RESOLVED_EMAIL_OR_LINEID_SQL,
  RESOLVED_PHONE_SQL,
  RESOLVED_STAFF_NAME_SQL,
  assertSsotStaffRows,
} from '../services/appointmentIdentitySql.js';
import { formatTreatmentDisplay, resolveTreatmentDisplay } from '../utils/treatmentDisplay.js';
import { resolveAppointmentFieldsByAppointmentId } from '../utils/resolveAppointmentFields.js';
import { parseBranchFilterQuery } from '../utils/branchContract.js';
import { readScGlamLiffEnv } from '../config/env.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const DEBUG_PHONE_FRAGMENT = String(readScGlamLiffEnv('SCGLAMLIFF_DEBUG_QUEUE_PHONE_FRAGMENT')).replace(/\D+/g, '');
const DEBUG_TREATMENT_CATALOG_PREVIEW = String(readScGlamLiffEnv('SCGLAMLIFF_DEBUG_TREATMENT_CATALOG_PREVIEW')).toLowerCase() === 'true';
const SMOOTH_CODE = 'smooth';
const E2E_MARKER_REGEX_SQL = '^(e2e_|e2e_workflow_|verify-)';

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function parseLimit(value) {
  const raw = normalizeText(value);
  if (!raw) {
    return { limit: DEFAULT_LIMIT, warning: null };
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return {
      limit: DEFAULT_LIMIT,
      warning: {
        param: 'limit',
        provided: raw,
        applied: DEFAULT_LIMIT,
        reason: 'must be a positive integer',
      },
    };
  }

  if (parsed > MAX_LIMIT) {
    return {
      limit: MAX_LIMIT,
      warning: {
        param: 'limit',
        provided: raw,
        applied: MAX_LIMIT,
        reason: `exceeds max ${MAX_LIMIT}; capped to maximum`,
      },
    };
  }

  return { limit: parsed, warning: null };
}

function badRequest(res, message, details = {}) {
  return res.status(400).json({
    ok: false,
    error: 'Bad Request',
    message,
    details,
  });
}

function toInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.trunc(parsed);
}

function sanitizeThaiPhone(value) {
  const digits = normalizeText(value).replace(/\D+/g, '');
  if (!digits) return '';

  if (digits.startsWith('66') && digits.length === 11) {
    return `0${digits.slice(-9)}`;
  }

  if (digits.length === 10 && digits.startsWith('0')) {
    return digits;
  }

  if (digits.length === 9 && !digits.startsWith('0')) {
    return `0${digits}`;
  }

  return '';
}

function sanitizeDisplayLineId(value) {
  const text = normalizeText(value);
  if (!text) return '';

  if (text === '__STAFF__' || text === '__BACKDATE__') {
    return '';
  }

  const lowered = text.toLowerCase();
  if (lowered.startsWith('phone:') || lowered.startsWith('sheet:')) {
    return '';
  }

  return text;
}

function formatPackageLabel(pkgRow, { treatmentNameEn = '', treatmentNameTh = '', treatmentCode = '' } = {}) {
  return formatTreatmentDisplay({
    treatmentNameEn,
    treatmentNameTh,
    treatmentCode,
    treatmentSessions: Math.max(0, toInt(pkgRow.sessions_total)) || 1,
    treatmentMask: Math.max(0, toInt(pkgRow.mask_total)),
    treatmentPrice: Math.max(0, toInt(pkgRow.price_thb)) || null,
  });
}

function mapTreatmentToOption(row) {
  const treatmentId = normalizeText(row.id);
  const treatmentNameEn = normalizeText(row.treatment_name_en);
  const treatmentNameTh = normalizeText(row.treatment_name_th);
  const treatmentCode = normalizeText(row.code);
  const title = treatmentNameEn || treatmentNameTh || normalizeText(row.treatment_name);
  const sessions = Math.max(0, toInt(row.sessions_included)) || 1;
  const mask = Math.max(0, toInt(row.mask_included));
  const price = Math.max(0, toInt(row.price_thb)) || null;
  const resolved = resolveTreatmentDisplay({
    treatmentId,
    treatmentNameEn,
    treatmentNameTh,
    treatmentCode,
    treatmentSessions: sessions,
    treatmentMask: mask,
    treatmentPrice: price,
    legacyText: title,
  });
  const display = resolved.treatment_display || formatTreatmentDisplay({
    treatmentNameEn,
    treatmentNameTh,
    treatmentCode,
    treatmentName: title,
    treatmentSessions: sessions,
    treatmentMask: mask,
    treatmentPrice: price,
  });
  const canonicalName = normalizeText(resolved.treatment_name) || title;

  return {
    value: `treatment:${treatmentId}`,
    label: display,
    source: 'treatment',
    treatment_id: treatmentId,
    treatment_item_text: display,
    treatment_name: canonicalName,
    treatment_name_en: treatmentNameEn || null,
    treatment_name_th: treatmentNameTh || null,
    treatment_code: treatmentCode,
    treatment_sessions: sessions,
    treatment_mask: mask,
    treatment_price: price,
    treatment_display: display,
    treatment_display_source: 'catalog',
  };
}

function buildQueueFilters({ date, branchId }) {
  const params = [];
  const whereParts = [];
  // Policy: queue table must show all statuses; do not hide rows by status here.

  if (branchId) {
    params.push(branchId);
    whereParts.push(`a.branch_id = $${params.length}`);
  }

  if (date) {
    params.push(date);
    whereParts.push(`DATE(a.scheduled_at AT TIME ZONE 'Asia/Bangkok') = $${params.length}`);
  }

  return { params, whereParts };
}

async function fetchResolvedPlanByAppointmentIds(appointmentIds) {
  const ids = [...new Set((appointmentIds || []).map((value) => normalizeText(value)).filter(Boolean))].filter(
    (value) => UUID_PATTERN_RE.test(value)
  );
  if (ids.length === 0) return new Map();

  const result = await query(
    `
      SELECT
        ae.appointment_id,
        ae.id,
        ae.event_type,
        ae.event_at,
        ae.meta
      FROM appointment_events ae
      WHERE ae.appointment_id = ANY($1::uuid[])
        AND (
          COALESCE(ae.meta->'after', '{}'::jsonb) ? 'treatment_item_text'
          OR ae.meta ? 'treatment_item_text'
          OR COALESCE(ae.meta->'after', '{}'::jsonb) ? 'treatment_plan_mode'
          OR ae.meta ? 'treatment_plan_mode'
          OR COALESCE(ae.meta->'after', '{}'::jsonb) ? 'package_id'
          OR ae.meta ? 'package_id'
          OR COALESCE(ae.meta->'after', '{}'::jsonb) ? 'unlink_package'
          OR ae.meta ? 'unlink_package'
          OR COALESCE(ae.meta->'after', '{}'::jsonb) ? 'package_unlinked'
          OR ae.meta ? 'package_unlinked'
        )
      ORDER BY ae.appointment_id ASC, ae.event_at DESC NULLS LAST, ae.id DESC
    `,
    [ids]
  );

  return resolveAppointmentFieldsByAppointmentId(result.rows || []);
}

async function fetchPackageCatalogByIds(packageIds) {
  const ids = [...new Set((packageIds || []).map((value) => normalizeText(value)).filter(Boolean))].filter((id) =>
    UUID_PATTERN_RE.test(id)
  );
  if (ids.length === 0) return new Map();

  const result = await query(
    `
      SELECT
        p.id,
        p.code,
        p.title,
        COALESCE(p.sessions_total, 0)::int AS sessions_total,
        COALESCE(p.mask_total, 0)::int AS mask_total,
        COALESCE(p.price_thb, 0)::int AS price_thb
      FROM packages p
      WHERE p.id = ANY($1::uuid[])
    `,
    [ids]
  );

  const byId = new Map();
  for (const row of result.rows || []) {
    byId.set(normalizeText(row.id), row);
  }
  return byId;
}

export async function listBookingTreatmentOptions(req, res) {
  try {
    const bookingChannel = normalizeText(req.query?.channel);

    if (isLiffReceiptPromoChannel(bookingChannel)) {
      if (!isLiffReceiptPromoActive()) {
        return res.json({
          ok: true,
          options: [],
          meta: {
            booking_channel: LIFF_RECEIPT_PROMO_BOOKING_CHANNEL,
            active: false,
            active_from: LIFF_RECEIPT_PROMO_ACTIVE_FROM,
            active_until: LIFF_RECEIPT_PROMO_ACTIVE_UNTIL,
          },
        });
      }

      const promoTreatmentResult = await query(
        `
          SELECT
            id,
            code,
            title_th,
            title_en,
            is_active
          FROM treatments
          WHERE LOWER(COALESCE(code, '')) = LOWER($1)
            AND is_active = true
          LIMIT 1
        `,
        [LIFF_RECEIPT_PROMO_TREATMENT_CODE]
      );

      const promoTreatment = promoTreatmentResult.rows[0] || null;
      if (!promoTreatment?.id) {
        return res.status(500).json({
          ok: false,
          error: 'Temporary promo treatment is not configured',
          code: 'LIFF_RECEIPT_PROMO_TREATMENT_MISSING',
        });
      }

      return res.json({
        ok: true,
        options: [buildLiffReceiptPromoBookingOption(promoTreatment)],
        meta: {
          booking_channel: LIFF_RECEIPT_PROMO_BOOKING_CHANNEL,
          active: true,
          active_from: LIFF_RECEIPT_PROMO_ACTIVE_FROM,
          active_until: LIFF_RECEIPT_PROMO_ACTIVE_UNTIL,
        },
      });
    }

    const treatmentResult = await query(
      `
        SELECT
          t.id,
          t.code,
          COALESCE(NULLIF(to_jsonb(t)->>'name_th', ''), NULLIF(t.title_th, ''), '') AS treatment_name_th,
          COALESCE(NULLIF(to_jsonb(t)->>'name_en', ''), NULLIF(t.title_en, ''), '') AS treatment_name_en,
          t.title_th,
          t.title_en,
          t.is_active,
          COALESCE(
            NULLIF(to_jsonb(t)->>'name_en', ''),
            NULLIF(t.title_en, ''),
            NULLIF(to_jsonb(t)->>'name_th', ''),
            NULLIF(t.title_th, ''),
            NULLIF(t.code, ''),
            'Treatment'
          ) AS treatment_name,
          CASE
            WHEN COALESCE(to_jsonb(t)->>'price_thb', '') ~ '^[0-9]+$'
              THEN (to_jsonb(t)->>'price_thb')::int
            ELSE NULL
          END AS price_thb,
          CASE
            WHEN COALESCE(to_jsonb(t)->>'sessions_included', '') ~ '^[0-9]+$'
              THEN (to_jsonb(t)->>'sessions_included')::int
            ELSE NULL
          END AS sessions_included,
          CASE
            WHEN COALESCE(to_jsonb(t)->>'mask_included', '') ~ '^[0-9]+$'
              THEN (to_jsonb(t)->>'mask_included')::int
            ELSE NULL
          END AS mask_included
        FROM treatments t
        WHERE is_active = true
        ORDER BY code ASC, created_at ASC
      `
    );

    const treatments = treatmentResult.rows || [];
    const options = [];

    if (DEBUG_TREATMENT_CATALOG_PREVIEW && String(process.env.NODE_ENV || '').toLowerCase() !== 'production') {
      const previewRows = treatments.map((row) => ({
        treatment_id: normalizeText(row.id),
        treatment_code: normalizeText(row.code),
        name_en: normalizeText(row.treatment_name_en),
        name_th: normalizeText(row.treatment_name_th),
        treatment_display: formatTreatmentDisplay({
          treatmentNameEn: normalizeText(row.treatment_name_en),
          treatmentNameTh: normalizeText(row.treatment_name_th),
          treatmentCode: normalizeText(row.code),
          treatmentSessions: Math.max(0, toInt(row.sessions_included)) || 1,
          treatmentMask: Math.max(0, toInt(row.mask_included)),
          treatmentPrice: Math.max(0, toInt(row.price_thb)) || null,
        }),
      }));
      console.log('[booking-options] treatment catalog preview');
      console.table(previewRows);
    }

    const smoothTreatment = treatments.find(
      (row) => normalizeText(row.code).toLowerCase() === SMOOTH_CODE
    );

    if (smoothTreatment) {
      const smoothDisplayNameEn =
        normalizeText(smoothTreatment.treatment_name_en) ||
        normalizeText(smoothTreatment.treatment_name) ||
        'Smooth';
      const smoothDisplayNameTh = normalizeText(smoothTreatment.treatment_name_th);
      const packageResult = await query(
        `
          SELECT
            id,
            code,
            title,
            sessions_total,
            mask_total,
            price_thb
          FROM packages
          WHERE LOWER(COALESCE(code, '')) LIKE 'smooth%'
          ORDER BY sessions_total ASC, price_thb ASC, title ASC
        `
      );

      for (const pkg of packageResult.rows || []) {
        const value = normalizeText(pkg.id);
        if (!value) continue;
        const sessions = Math.max(0, toInt(pkg.sessions_total)) || 1;
        const mask = Math.max(0, toInt(pkg.mask_total));
        const price = Math.max(0, toInt(pkg.price_thb)) || null;
        const label = formatPackageLabel(pkg, {
          treatmentNameEn: smoothDisplayNameEn,
          treatmentNameTh: smoothDisplayNameTh,
          treatmentCode: smoothTreatment.code,
        });
        options.push({
          value: `package:${value}`,
          label,
          source: 'package',
          treatment_id: smoothTreatment.id,
          treatment_item_text: label,
          treatment_name: smoothDisplayNameEn || smoothDisplayNameTh || 'Smooth',
          treatment_name_en: smoothDisplayNameEn || null,
          treatment_name_th: smoothDisplayNameTh || null,
          treatment_code: normalizeText(smoothTreatment.code),
          treatment_sessions: sessions,
          treatment_mask: mask,
          treatment_price: price,
          treatment_display: label,
          treatment_display_source: 'catalog',
          package_id: value,
          package_code: normalizeText(pkg.code),
          sessions_total: sessions,
          mask_total: mask,
          price_thb: price || 0,
        });
      }

      if (!options.some((option) => option.source === 'package')) {
        options.push(mapTreatmentToOption(smoothTreatment));
      }
    }

    for (const treatment of treatments) {
      if (normalizeText(treatment.code).toLowerCase() === SMOOTH_CODE) continue;
      options.push(mapTreatmentToOption(treatment));
    }

    return res.json({ ok: true, options });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

export async function listAppointmentsQueue(req, res) {
  const date = normalizeText(req.query?.date);
  let branchId = '';
  const { limit, warning: limitWarning } = parseLimit(req.query?.limit);

  if (date && !DATE_PATTERN.test(date)) {
    return badRequest(res, 'Invalid query parameter: date', {
      param: 'date',
      provided: date,
      expected: 'YYYY-MM-DD',
    });
  }

  try {
    branchId = parseBranchFilterQuery(req.query?.branch_id);
  } catch (error) {
    if (error?.status === 400) {
      return badRequest(res, error.message, error.details || {});
    }
    throw error;
  }

  try {
    const { params, whereParts } = buildQueueFilters({ date, branchId });
    params.push(limit);
    const limitParam = `$${params.length}`;

    const orderBy = date ? 'a.scheduled_at ASC' : 'a.scheduled_at DESC';

    // Canonical naming source: prefer treatments.name_en/title_en, fallback to Thai only when English is unavailable.
    const { rows } = await query(
      `
        SELECT
          a.id,
          a.id AS appointment_id,
          a.scheduled_at AS scheduled_at,
          a.status AS status,
          a.branch_id AS branch_id,
          a.treatment_id AS treatment_id,
          a.customer_id AS customer_id,
          a.raw_sheet_uuid AS raw_sheet_uuid,
          a.selected_toppings AS selected_toppings,
          a.addons_total_thb AS addons_total_thb,
          COALESCE(NULLIF(t.code, ''), '') AS treatment_code,
          COALESCE(NULLIF(to_jsonb(t)->>'name_en', ''), NULLIF(t.title_en, ''), '') AS treatment_name_en,
          COALESCE(NULLIF(to_jsonb(t)->>'name_th', ''), NULLIF(t.title_th, ''), '') AS treatment_name_th,
          COALESCE(NULLIF(t.title_en, ''), '') AS treatment_title_en,
          COALESCE(TO_CHAR(a.scheduled_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD'), '') AS date,
          COALESCE(TO_CHAR(a.scheduled_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI'), '') AS "bookingTime",
          COALESCE(c.full_name, '') AS customer_full_name,
          COALESCE(c.full_name, '') AS "customerName",
          ${RESOLVED_PHONE_SQL} AS phone,
          ${RESOLVED_EMAIL_OR_LINEID_SQL} AS "lineId",
          COALESCE(
            NULLIF(to_jsonb(t)->>'name_en', ''),
            NULLIF(t.title_en, ''),
            NULLIF(to_jsonb(t)->>'name_th', ''),
            NULLIF(t.title_th, ''),
            NULLIF(t.code, ''),
            ''
          ) AS treatment_name,
          COALESCE(
            NULLIF(to_jsonb(t)->>'name_en', ''),
            NULLIF(t.title_en, ''),
            NULLIF(to_jsonb(t)->>'name_th', ''),
            NULLIF(t.title_th, ''),
            NULLIF(t.code, ''),
            ''
          ) AS "treatmentItem",
          COALESCE(
            NULLIF(to_jsonb(t)->>'name_en', ''),
            NULLIF(t.title_en, ''),
            NULLIF(to_jsonb(t)->>'name_th', ''),
            NULLIF(t.title_th, ''),
            NULLIF(t.code, ''),
            ''
          ) AS treatment_item_text,
          CASE
            WHEN COALESCE(to_jsonb(t)->>'sessions_included', '') ~ '^[0-9]+$'
              THEN (to_jsonb(t)->>'sessions_included')::int
            ELSE NULL
          END AS treatment_sessions_base,
          CASE
            WHEN COALESCE(to_jsonb(t)->>'mask_included', '') ~ '^[0-9]+$'
              THEN (to_jsonb(t)->>'mask_included')::int
            ELSE NULL
          END AS treatment_mask_base,
          CASE
            WHEN COALESCE(to_jsonb(t)->>'price_thb', '') ~ '^[0-9]+$'
              THEN (to_jsonb(t)->>'price_thb')::int
            ELSE NULL
          END AS treatment_price_base,
          CASE
            WHEN COALESCE(to_jsonb(t)->>'sessions_included', '') ~ '^[0-9]+$'
              THEN (to_jsonb(t)->>'sessions_included')::int
            ELSE NULL
          END AS treatment_sessions_catalog,
          CASE
            WHEN COALESCE(to_jsonb(t)->>'mask_included', '') ~ '^[0-9]+$'
              THEN (to_jsonb(t)->>'mask_included')::int
            ELSE NULL
          END AS treatment_mask_catalog,
          CASE
            WHEN COALESCE(to_jsonb(t)->>'price_thb', '') ~ '^[0-9]+$'
              THEN (to_jsonb(t)->>'price_thb')::int
            ELSE NULL
          END AS treatment_price_catalog,
          ''::text AS treatment_item_text_override,
          ''::text AS treatment_plan_mode,
          ''::text AS treatment_plan_package_id,
          COALESCE(pu_current.customer_package_id, NULL) AS smooth_usage_customer_package_id,
          COALESCE(smooth_pkg.customer_package_id, NULL) AS smooth_customer_package_id,
          COALESCE(NULLIF(smooth_pkg.customer_package_status, ''), '') AS smooth_customer_package_status,
          COALESCE(
            smooth_pkg.sessions_total,
            smooth_default.sessions_total,
            0
          ) AS smooth_sessions_total,
          COALESCE(
            smooth_pkg.mask_total,
            smooth_default.mask_total,
            0
          ) AS smooth_mask_total,
          COALESCE(
            smooth_pkg.price_thb,
            smooth_default.price_thb,
            0
          ) AS smooth_price_thb,
          COALESCE(smooth_pkg.sessions_used, 0) AS smooth_sessions_used,
          COALESCE(smooth_pkg.mask_used, 0) AS smooth_mask_used,
          ${RESOLVED_STAFF_NAME_SQL} AS "staffName",
          ${RESOLVED_STAFF_NAME_SQL} AS staff_name
        FROM appointments a
        LEFT JOIN customers c ON a.customer_id = c.id
        LEFT JOIN treatments t ON a.treatment_id = t.id
        LEFT JOIN LATERAL (
          SELECT
            p.sessions_total,
            p.mask_total,
            p.price_thb
          FROM packages p
          WHERE LOWER(COALESCE(p.code, '')) LIKE 'smooth%'
            AND COALESCE(p.sessions_total, 0) = 1
          ORDER BY p.price_thb ASC NULLS LAST, p.id ASC
          LIMIT 1
        ) smooth_default ON true
        LEFT JOIN LATERAL (
          SELECT
            pu.customer_package_id,
            pu.used_mask
          FROM package_usages pu
          WHERE pu.appointment_id = a.id
          ORDER BY pu.used_at DESC NULLS LAST, pu.id DESC
          LIMIT 1
        ) pu_current ON true
        LEFT JOIN LATERAL (
          SELECT
            cp.id AS customer_package_id,
            cp.status AS customer_package_status,
            p.sessions_total,
            p.mask_total,
            p.price_thb,
            COALESCE(u.sessions_used, 0) AS sessions_used,
            COALESCE(u.mask_used, 0) AS mask_used
          FROM customer_packages cp
          JOIN packages p ON p.id = cp.package_id
          LEFT JOIN LATERAL (
            SELECT
              COUNT(*)::int AS sessions_used,
              COUNT(*) FILTER (WHERE used_mask IS TRUE)::int AS mask_used
            FROM package_usages pu
            WHERE pu.customer_package_id = cp.id
          ) u ON true
          WHERE cp.customer_id = c.id
            AND LOWER(COALESCE(cp.status, '')) = 'active'
            AND LOWER(COALESCE(p.code, '')) LIKE 'smooth%'
          ORDER BY cp.purchased_at DESC NULLS LAST, cp.id DESC
          LIMIT 1
        ) smooth_pkg ON true
        ${APPOINTMENT_IDENTITY_JOINS_SQL}
        ${whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : ''}
        ORDER BY ${orderBy}
        LIMIT ${limitParam}
      `,
      params
    );

    assertSsotStaffRows(rows, {
      endpointLabel: '/api/appointments/queue',
      idFields: ['appointment_id', 'id'],
      staffFields: ['staffName'],
    });

    const appointmentIds = [...new Set(
      rows
        .map((row) => normalizeText(row.appointment_id || row.id))
        .filter((id) => UUID_PATTERN_RE.test(id))
    )];
    // Resolve plan/package fields from event history per-field (not latest single row),
    // so partial admin edits do not accidentally drop package linkage in queue rendering.
    const resolvedPlanByAppointmentId = await fetchResolvedPlanByAppointmentIds(appointmentIds);
    const resolvedPackageIds = [...new Set(
      [...resolvedPlanByAppointmentId.values()]
        .map((resolved) => normalizeText(resolved?.package_id))
        .filter((id) => UUID_PATTERN_RE.test(id))
    )];
    const resolvedPlanPackageById = await fetchPackageCatalogByIds(resolvedPackageIds);

    const normalizedRows = rows.map((row) => {
      const appointmentId = normalizeText(row.appointment_id || row.id);
      const resolvedPlan = resolvedPlanByAppointmentId.get(appointmentId) || {
        package_id: '',
        treatment_plan_mode: '',
        treatment_item_text: '',
      };
      const resolvedPlanMode = normalizeText(resolvedPlan.treatment_plan_mode);
      const resolvedPlanPackageIdRaw = normalizeText(resolvedPlan.package_id);
      const resolvedPlanPackageId = UUID_PATTERN_RE.test(resolvedPlanPackageIdRaw)
        ? resolvedPlanPackageIdRaw
        : '';
      const resolvedPlanText = normalizeText(resolvedPlan.treatment_item_text);
      const resolvedPlanPackage = resolvedPlanPackageId
        ? resolvedPlanPackageById.get(resolvedPlanPackageId) || null
        : null;

      const treatmentSessionsBase = Math.max(0, toInt(row.treatment_sessions_base));
      const treatmentMaskBase = Math.max(0, toInt(row.treatment_mask_base));
      const treatmentPriceBase = Math.max(0, toInt(row.treatment_price_base));
      const treatmentSessionsCatalog = resolvedPlanPackage
        ? Math.max(0, toInt(resolvedPlanPackage.sessions_total))
        : resolvedPlanMode === 'one_off'
          ? 1
          : treatmentSessionsBase || null;
      const treatmentMaskCatalog = resolvedPlanPackage
        ? Math.max(0, toInt(resolvedPlanPackage.mask_total))
        : resolvedPlanMode === 'one_off'
          ? 0
          : treatmentMaskBase || null;
      const treatmentPriceCatalog = resolvedPlanPackage
        ? Math.max(0, toInt(resolvedPlanPackage.price_thb))
        : treatmentPriceBase || null;

      const rawPhone = normalizeText(row.phone);
      const normalizedPhone = sanitizeThaiPhone(rawPhone);
      const legacyTreatmentText =
        resolvedPlanText || normalizeText(row.treatment_item_text) || normalizeText(row.treatmentItem);
      // Catalog-first treatment display; only parse legacy text when appointment has no treatment_id.
      const resolvedTreatment = resolveTreatmentDisplay({
        treatmentId: row.treatment_id,
        treatmentName: row.treatment_name,
        treatmentNameEn: row.treatment_name_en,
        treatmentNameTh: row.treatment_name_th,
        treatmentCode: row.treatment_code,
        treatmentSessions: treatmentSessionsCatalog,
        treatmentMask: treatmentMaskCatalog,
        treatmentPrice: treatmentPriceCatalog,
        legacyText: legacyTreatmentText,
      });
      const hasCatalogId = UUID_PATTERN_RE.test(normalizeText(row.treatment_id));

      const smoothUsagePackageId = normalizeText(row.smooth_usage_customer_package_id);
      const smoothFallbackPackageId = normalizeText(row.smooth_customer_package_id);
      // Do not auto-fallback to unrelated packages when an explicit plan mode exists.
      const smoothCustomerPackageId =
        smoothUsagePackageId || (!resolvedPlanMode ? smoothFallbackPackageId : '');
      const smoothCustomerPackageStatus = smoothCustomerPackageId
        ? normalizeText(row.smooth_customer_package_status).toLowerCase()
        : '';
      const smoothSessionsTotal = Math.max(0, toInt(row.smooth_sessions_total));
      const smoothSessionsUsed = Math.max(0, toInt(row.smooth_sessions_used));
      const smoothSessionsRemaining = Math.max(0, smoothSessionsTotal - smoothSessionsUsed);

      if (DEBUG_PHONE_FRAGMENT) {
        const rawDigits = rawPhone.replace(/\D+/g, '');
        const normalizedDigits = normalizedPhone.replace(/\D+/g, '');
        if (rawDigits.includes(DEBUG_PHONE_FRAGMENT) || normalizedDigits.includes(DEBUG_PHONE_FRAGMENT)) {
          console.log(
            `[appointmentsQueue] phone_trace raw_sheet_uuid=${row.raw_sheet_uuid || ''} customer="${normalizeText(row.customer_full_name || row.customerName)}" raw_phone="${rawPhone}" normalized_phone="${normalizedPhone}"`
          );
        }
      }

      return {
        ...row,
        phone: normalizedPhone,
        lineId: sanitizeDisplayLineId(row.lineId),
        staffName: normalizeText(row.staffName),
        staff_name: normalizeText(row.staff_name || row.staffName),
        treatment_plan_mode: resolvedPlanMode,
        treatment_plan_package_id: resolvedPlanPackageId,
        treatment_item_text_override: resolvedPlanText,
        treatment_name: resolvedTreatment.treatment_name,
        treatment_name_en: normalizeText(row.treatment_name_en),
        treatment_name_th: normalizeText(row.treatment_name_th),
        treatment_sessions: resolvedTreatment.treatment_sessions,
        treatment_mask: resolvedTreatment.treatment_mask,
        treatment_price: resolvedTreatment.treatment_price,
        treatment_display: resolvedTreatment.treatment_display,
        treatment_display_source: resolvedTreatment.treatment_display_source,
        treatment_sessions_catalog: treatmentSessionsCatalog,
        treatment_mask_catalog: treatmentMaskCatalog,
        treatment_price_catalog: treatmentPriceCatalog,
        treatment_item_text: hasCatalogId
          ? resolvedTreatment.treatment_display
          : legacyTreatmentText || resolvedTreatment.treatment_display,
        treatmentItem: resolvedTreatment.treatment_display,
        treatmentItemDisplay: resolvedTreatment.treatment_display,
        treatmentDisplay: resolvedTreatment.treatment_display,
        smooth_customer_package_id: smoothCustomerPackageId || null,
        smooth_customer_package_status: smoothCustomerPackageStatus,
        smooth_sessions_remaining: smoothSessionsRemaining,
        has_continuous_course: Boolean(
          smoothCustomerPackageId &&
            ((smoothCustomerPackageStatus === 'active' && smoothSessionsRemaining > 0) ||
              (smoothCustomerPackageStatus === '' && smoothSessionsRemaining > 0))
        ),
      };
    });

    const responseBody = { ok: true, rows: normalizedRows };
    if (limitWarning) {
      responseBody.meta = { warnings: [limitWarning] };
    }

    return res.json(responseBody);
  } catch (error) {
    const errorCode = normalizeText(error?.code);
    const errorMessage = normalizeText(error?.message) || 'Queue query failed';
    const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    console.error('[appointmentsQueue] queue query failed', {
      code: errorCode || null,
      message: errorMessage,
      details: error?.details || null,
    });

    if (error?.code === 'SSOT_STAFF_MISSING') {
      return res.status(500).json({
        ok: false,
        error: 'SSOT staff_name missing',
        message: isProd ? 'Queue SSOT staff validation failed.' : errorMessage,
        code: error.code,
        details: error?.details || null,
      });
    }

    return res.status(500).json({
      ok: false,
      error: 'Queue query failed',
      message: isProd
        ? 'Backend queue query failed. Check Render logs for SQL/schema mismatch.'
        : errorMessage,
      code: errorCode || null,
      details: isProd ? null : error?.details || null,
    });
  }
}

export async function listAppointmentCalendarDays(req, res) {
  const from = normalizeText(req.query?.from);
  const to = normalizeText(req.query?.to);
  let branchId = '';

  if (!from || !to) {
    return badRequest(res, 'Missing query parameters: from/to', {
      required: ['from', 'to'],
    });
  }

  if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(to)) {
    return badRequest(res, 'Invalid query parameter: from/to', {
      from,
      to,
      expected: 'YYYY-MM-DD',
    });
  }

  if (from > to) {
    return badRequest(res, 'Invalid date range: from is after to', { from, to });
  }

  try {
    branchId = parseBranchFilterQuery(req.query?.branch_id);
  } catch (error) {
    if (error?.status === 400) {
      return badRequest(res, error.message, error.details || {});
    }
    throw error;
  }

  try {
    const params = [from, to];
    const whereParts = [
      `DATE(a.scheduled_at AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2`,
    ];
    params.push(E2E_MARKER_REGEX_SQL);
    const e2eRegexParam = `$${params.length}`;
    whereParts.push(
      `NOT (
        COALESCE(c.full_name, '') ~* ${e2eRegexParam}
        OR COALESCE(a.line_user_id, '') ~* ${e2eRegexParam}
      )`
    );

    if (branchId) {
      params.push(branchId);
      whereParts.push(`a.branch_id = $${params.length}`);
    }

    const { rows } = await query(
      `
        SELECT
          TO_CHAR(
            DATE(a.scheduled_at AT TIME ZONE 'Asia/Bangkok'),
            'YYYY-MM-DD'
          ) AS date,
          COUNT(*)::int AS count,
          SUM(CASE WHEN LOWER(COALESCE(a.status, '')) = 'booked' THEN 1 ELSE 0 END)::int AS booked_count,
          SUM(CASE WHEN LOWER(COALESCE(a.status, '')) = 'completed' THEN 1 ELSE 0 END)::int AS completed_count,
          SUM(CASE WHEN LOWER(COALESCE(a.status, '')) IN ('no_show', 'no-show', 'noshow') THEN 1 ELSE 0 END)::int AS no_show_count,
          SUM(CASE WHEN LOWER(COALESCE(a.status, '')) IN ('cancelled', 'canceled') THEN 1 ELSE 0 END)::int AS cancelled_count
        FROM appointments a
        LEFT JOIN customers c ON a.customer_id = c.id
        WHERE ${whereParts.join(' AND ')}
        GROUP BY DATE(a.scheduled_at AT TIME ZONE 'Asia/Bangkok')
        ORDER BY DATE(a.scheduled_at AT TIME ZONE 'Asia/Bangkok') ASC
      `,
      params
    );

    const days = (rows || []).map((row) => ({
      date: normalizeText(row.date),
      count: Number(row.count) || 0,
      status_counts: {
        booked: Number(row.booked_count) || 0,
        completed: Number(row.completed_count) || 0,
        no_show: Number(row.no_show_count) || 0,
        cancelled: Number(row.cancelled_count) || 0,
      },
    }));

    return res.json({ ok: true, from, to, days });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
