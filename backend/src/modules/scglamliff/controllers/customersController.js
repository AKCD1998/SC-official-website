import { query } from '../db.js';
import { formatTreatmentDisplay, resolveTreatmentDisplay } from '../utils/treatmentDisplay.js';
import { resolveAppointmentFieldsByAppointmentId } from '../utils/resolveAppointmentFields.js';

const UUID_PATTERN_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function toInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.trunc(parsed);
}

function formatPackageDisplay({ packageCode = '', packageTitle = '', sessionsTotal = 1, maskTotal = 0, priceThb = null } = {}) {
  // Package cards/history must share the same formatter semantics as queue/booking labels.
  return formatTreatmentDisplay({
    treatmentName: packageTitle || packageCode || 'Treatment',
    treatmentCode: packageCode,
    treatmentSessions: sessionsTotal || 1,
    treatmentMask: maskTotal,
    treatmentPrice: priceThb,
  });
}

async function fetchResolvedPlanByAppointmentIds(appointmentIds) {
  const ids = [...new Set((appointmentIds || []).map((value) => normalizeText(value)).filter(Boolean))].filter(
    (id) => UUID_PATTERN_RE.test(id)
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
        p.sessions_total,
        p.mask_total,
        p.price_thb
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

export async function listCustomers(req, res) {
  try {
    const { rows } = await query(
      `
        SELECT
          id,
          full_name,
          created_at
        FROM customers
        WHERE lower(trim(full_name)) NOT IN ('test user', 'unknown')
        ORDER BY created_at DESC
        LIMIT 200
      `
    );

    return res.json({ ok: true, rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

export async function getCustomerProfile(req, res) {
  const customerId = req.params.customerId;
  if (!customerId) {
    return res.status(400).json({ ok: false, error: 'Missing customerId' });
  }

  try {
    const customerResult = await query(
      `
        SELECT
          id,
          full_name,
          created_at
        FROM customers
        WHERE id = $1
        LIMIT 1
      `,
      [customerId]
    );

    if (customerResult.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Customer not found' });
    }

    let packages = [];
    try {
      const packagesResult = await query(
        `
          SELECT
            cp.id AS customer_package_id,
            cp.status,
            cp.purchased_at,
            NULLIF((to_jsonb(cp) ->> 'expires_at'), '')::timestamptz AS expires_at,
            p.code AS package_code,
            p.title AS package_title,
            p.sessions_total,
            p.mask_total,
            p.price_thb,
            COALESCE(u.sessions_used, 0) AS sessions_used,
            COALESCE(u.mask_used, 0) AS mask_used
          FROM customer_packages cp
          JOIN packages p ON p.id = cp.package_id
          LEFT JOIN (
            SELECT
              customer_package_id,
              COUNT(*)::int AS sessions_used,
              COUNT(*) FILTER (WHERE used_mask IS TRUE)::int AS mask_used
            FROM package_usages
            GROUP BY customer_package_id
          ) u ON u.customer_package_id = cp.id
          WHERE cp.customer_id = $1
          ORDER BY cp.purchased_at DESC NULLS LAST
        `,
        [customerId]
      );

      packages = packagesResult.rows.map((row) => {
        const sessionsTotal = Number(row.sessions_total) || 0;
        const maskTotal = Number(row.mask_total) || 0;
        const sessionsUsed = Number(row.sessions_used) || 0;
        const maskUsed = Number(row.mask_used) || 0;
        const treatmentDisplay = formatPackageDisplay({
          packageCode: row.package_code,
          packageTitle: row.package_title,
          sessionsTotal: sessionsTotal || 1,
          maskTotal,
          priceThb: Number(row.price_thb) || null,
        });

        return {
          customer_package_id: row.customer_package_id,
          status: row.status || 'active',
          purchased_at: row.purchased_at,
          expires_at: row.expires_at,
          package: {
            code: row.package_code,
            title: row.package_title,
            sessions_total: sessionsTotal,
            mask_total: maskTotal,
            price_thb: row.price_thb,
            treatment_display: treatmentDisplay,
          },
          treatment_display: treatmentDisplay,
          usage: {
            sessions_used: sessionsUsed,
            sessions_remaining: Math.max(sessionsTotal - sessionsUsed, 0),
            mask_used: maskUsed,
            mask_remaining: Math.max(maskTotal - maskUsed, 0),
          },
        };
      });
    } catch (error) {
      if (error?.code === '42P01') {
        packages = [];
      } else {
        throw error;
      }
    }

    let usageRows = [];
    try {
      const usageResult = await query(
        `
          SELECT
            pu.used_at,
            pu.session_no,
            pu.used_mask,
            p.code AS package_code,
            p.title AS package_title,
            p.sessions_total,
            p.mask_total,
            p.price_thb,
            s.display_name AS staff_display_name,
            a.id AS appointment_id,
            a.scheduled_at,
            a.branch_id,
            aa.topping_code AS appointment_addon_code,
            aa.addon_kind AS appointment_addon_kind,
            aa.amount_thb AS appointment_addon_amount_thb,
            COALESCE(ta.title_th, '') AS appointment_addon_title_th,
            COALESCE(ta.title_en, '') AS appointment_addon_title_en
          FROM package_usages pu
          JOIN customer_packages cp ON cp.id = pu.customer_package_id
          JOIN packages p ON p.id = cp.package_id
          LEFT JOIN staffs s ON s.id = pu.staff_id
          LEFT JOIN appointments a ON a.id = pu.appointment_id
          LEFT JOIN appointment_addons aa ON aa.appointment_id = a.id
          LEFT JOIN toppings ta ON ta.code = aa.topping_code
          WHERE cp.customer_id = $1
          ORDER BY pu.used_at DESC
          LIMIT 50
        `,
        [customerId]
      );

      usageRows = usageResult.rows;
    } catch (error) {
      if (error?.code === '42P01') {
        usageRows = [];
      } else if (error?.code === '42703') {
        try {
          const fallbackResult = await query(
            `
              SELECT
                pu.used_at,
                p.code AS package_code,
                p.title AS package_title,
                p.sessions_total,
                p.mask_total,
                p.price_thb,
                s.display_name AS staff_display_name,
                a.id AS appointment_id,
                a.scheduled_at,
                a.branch_id
              FROM package_usages pu
              JOIN customer_packages cp ON cp.id = pu.customer_package_id
              JOIN packages p ON p.id = cp.package_id
              LEFT JOIN staffs s ON s.id = pu.staff_id
              LEFT JOIN appointments a ON a.id = pu.appointment_id
              WHERE cp.customer_id = $1
              ORDER BY pu.used_at DESC
              LIMIT 50
            `,
            [customerId]
          );
          usageRows = fallbackResult.rows;
        } catch (fallbackError) {
          console.error('Usage fallback failed', fallbackError);
          usageRows = [];
        }
      } else {
        throw error;
      }
    }

    let appointmentRows = [];
    try {
      const limitRaw = typeof req.query?.appointment_limit === 'string' ? req.query.appointment_limit : '';
      const parsedLimit = Number.parseInt(limitRaw, 10);
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : 50;

      const appointmentResult = await query(
        `
          SELECT
            a.id,
            a.scheduled_at,
            a.status,
            a.branch_id,
            a.treatment_id,
            t.code AS treatment_code,
            COALESCE(NULLIF(to_jsonb(t)->>'name_en', ''), NULLIF(t.title_en, ''), '') AS treatment_name_en,
            COALESCE(NULLIF(to_jsonb(t)->>'name_th', ''), NULLIF(t.title_th, ''), '') AS treatment_name_th,
            t.title_th AS treatment_title_th,
            t.title_en AS treatment_title_en,
            COALESCE(
              NULLIF(to_jsonb(t)->>'name_en', ''),
              NULLIF(t.title_en, ''),
              NULLIF(to_jsonb(t)->>'name_th', ''),
              NULLIF(t.title_th, ''),
              NULLIF(t.code, ''),
              'Treatment'
            ) AS treatment_name,
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
            END AS treatment_price_base
          FROM appointments a
          LEFT JOIN treatments t ON t.id = a.treatment_id
          WHERE a.customer_id = $1
          ORDER BY a.scheduled_at DESC
          LIMIT $2
        `,
        [customerId, limit]
      );

      appointmentRows = appointmentResult.rows;
    } catch (error) {
      if (error?.code === '42P01') {
        appointmentRows = [];
      } else {
        throw error;
      }
    }

    const appointmentIds = [...new Set(
      appointmentRows
        .map((row) => normalizeText(row.id))
        .filter((id) => UUID_PATTERN_RE.test(id))
    )];
    const resolvedPlanByAppointmentId = await fetchResolvedPlanByAppointmentIds(appointmentIds);
    const resolvedPackageIds = [...new Set(
      [...resolvedPlanByAppointmentId.values()]
        .map((resolved) => normalizeText(resolved?.package_id))
        .filter((id) => UUID_PATTERN_RE.test(id))
    )];
    const resolvedPlanPackageById = await fetchPackageCatalogByIds(resolvedPackageIds);

    return res.json({
      ok: true,
      customer: customerResult.rows[0],
      packages,
      usage_history: usageRows.map((row) => ({
        treatment_display: formatPackageDisplay({
          packageCode: row.package_code,
          packageTitle: row.package_title,
          sessionsTotal: Number(row.sessions_total) || 1,
          maskTotal: Number(row.mask_total) || 0,
          priceThb: Number(row.price_thb) || null,
        }),
        sessions_total: Number(row.sessions_total) || 1,
        mask_total: Number(row.mask_total) || 0,
        price_thb: Number(row.price_thb) || null,
        used_at: row.used_at,
        package_code: row.package_code,
        package_title: row.package_title,
        session_no: row.session_no,
        used_mask: row.used_mask,
        appointment_addon_code: row.appointment_addon_code,
        appointment_addon_kind: row.appointment_addon_kind,
        appointment_addon_amount_thb: Number(row.appointment_addon_amount_thb) || 0,
        appointment_addon_title_th: row.appointment_addon_title_th,
        appointment_addon_title_en: row.appointment_addon_title_en,
        staff_display_name: row.staff_display_name,
        appointment_id: row.appointment_id,
        scheduled_at: row.scheduled_at,
        branch_id: row.branch_id,
      })),
      appointment_history: appointmentRows.map((row) => {
        const appointmentId = normalizeText(row.id);
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
        const legacyTreatmentText =
          resolvedPlanText || normalizeText(row.treatment_item_text) || normalizeText(row.treatment_name);

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

        return {
          id: row.id,
          scheduled_at: row.scheduled_at,
          status: row.status,
          branch_id: row.branch_id,
          treatment_id: row.treatment_id,
          treatment_code: row.treatment_code,
          treatment_title_th: row.treatment_title_th,
          treatment_title_en: row.treatment_title_en,
          treatment_name_en: row.treatment_name_en,
          treatment_name_th: row.treatment_name_th,
          treatment_name: resolvedTreatment.treatment_name,
          treatment_sessions: resolvedTreatment.treatment_sessions,
          treatment_mask: resolvedTreatment.treatment_mask,
          treatment_price: resolvedTreatment.treatment_price,
          treatment_display: resolvedTreatment.treatment_display,
          treatment_display_source: resolvedTreatment.treatment_display_source,
          treatment_plan_mode: resolvedPlanMode,
          treatment_plan_package_id: resolvedPlanPackageId,
          treatment_item_text: hasCatalogId
            ? resolvedTreatment.treatment_display
            : legacyTreatmentText || resolvedTreatment.treatment_display,
        };
      }),
    });
  } catch (error) {
    console.error('getCustomerProfile failed', error);
    const message = error?.message || 'Server error';
    const code = error?.code || null;
    return res.status(500).json({ ok: false, error: message, code });
  }
}
