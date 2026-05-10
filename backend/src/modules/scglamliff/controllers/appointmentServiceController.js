import { pool } from '../db.js';
import { assertEventStaffIdentity } from '../services/appointmentEventStaffGuard.js';
import {
  computePackageRemaining,
  deriveContinuousPackageStatus,
  shouldShortCircuitCompletedAppointment,
  toNonNegativeInt,
} from '../services/packageContinuity.js';
import {
  clearAppointmentAddonSelection,
  getAppointmentAddonByAppointmentId,
  getAppointmentAddonDeductMask,
  resolveRequestedAppointmentAddonCode,
  upsertAppointmentAddonSelection,
} from '../services/appointmentAddonService.js';
import { resolveAppointmentFields } from '../utils/resolveAppointmentFields.js';
import { getDefaultBranchId } from '../config/env.js';
import {
  isPackageStyleTreatmentText,
  resolvePackageIdForBooking,
} from '../utils/resolvePackageIdForBooking.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DEFAULT_BRANCH_ID = getDefaultBranchId();
const REVERT_TARGET_STATUS = 'booked';
const REVERTABLE_STATUSES = new Set(['completed', 'no_show', 'cancelled', 'canceled']);
const MUTABLE_APPOINTMENT_STATUSES = new Set(['booked', 'rescheduled', 'ensured', 'confirmed']);

function isAdmin(user) {
  const role = String(user?.role_name || '').toLowerCase();
  return role === 'admin' || role === 'owner';
}

export function canRevertFromStatus(status) {
  return REVERTABLE_STATUSES.has(String(status || '').trim().toLowerCase());
}

function canMutateFromStatus(status) {
  return MUTABLE_APPOINTMENT_STATUSES.has(String(status || '').trim().toLowerCase());
}

function normalizePhone(raw) {
  if (!raw) return '';
  return String(raw).replace(/[^\d]/g, '').trim();
}

function normalizeText(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw).trim();
}

function parseOptionalInteger(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    const err = new Error(`${fieldName} must be an integer`);
    err.status = 400;
    throw err;
  }
  return parsed;
}

function parseDeductSessions(value) {
  const parsed = parseOptionalInteger(value, 'deduct_sessions');
  if (parsed === null) return 1;
  if (parsed !== 1) {
    const err = new Error('deduct_sessions must be 1 per appointment completion');
    err.status = 400;
    throw err;
  }
  return 1;
}

function parseDeductMask(value, { usedMask = false } = {}) {
  const parsed = parseOptionalInteger(value, 'deduct_mask');
  const resolved = parsed === null ? (usedMask ? 1 : 0) : parsed;
  if (resolved !== 0 && resolved !== 1) {
    const err = new Error('deduct_mask must be 0 or 1');
    err.status = 400;
    throw err;
  }
  return resolved;
}

function safeDisplayName(user) {
  return String(user?.display_name || user?.username || '').trim() || null;
}

function parseVisitTimeToHHMM(raw) {
  if (!raw) return null;
  const text = String(raw).trim().toLowerCase();
  const match = text.match(/(\d{1,2})[:.](\d{2})/);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

async function ensureStaffRow(client, user) {
  const userId = user?.id;
  const displayName = user?.display_name || user?.username || '';
  if (!userId) {
    throw new Error('Missing user id');
  }

  const upsert = await client.query(
    `
      INSERT INTO staffs (id, display_name, is_active, created_at)
      VALUES ($1, $2, true, now())
      ON CONFLICT (id)
      DO UPDATE SET
        display_name = EXCLUDED.display_name,
        is_active = true
      RETURNING id
    `,
    [userId, displayName || `staff-${userId}`]
  );
  return upsert.rows[0].id;
}

async function ensureLineUserRow(client, { lineUserId, displayName, customerId }) {
  if (!lineUserId) {
    const err = new Error('Missing line_user_id');
    err.status = 422;
    throw err;
  }

  const result = await client.query(
    `
      INSERT INTO line_users (line_user_id, display_name, customer_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (line_user_id)
      DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, line_users.display_name),
        customer_id = COALESCE(line_users.customer_id, EXCLUDED.customer_id)
      RETURNING line_user_id
    `,
    [lineUserId, displayName || null, customerId || null]
  );

  return result.rows[0].line_user_id;
}

async function resolveAppointment(client, idOrSheetUuid, options = {}) {
  const value = String(idOrSheetUuid || '').trim();
  if (!UUID_PATTERN.test(value)) {
    const err = new Error('Invalid appointment id');
    err.status = 400;
    throw err;
  }

  const lockClause = options.forUpdate ? ' FOR UPDATE' : '';

  const byId = await client.query(
    `SELECT * FROM appointments WHERE id = $1 LIMIT 1${lockClause}`,
    [value]
  );
  if (byId.rowCount > 0) return byId.rows[0];

  const bySheet = await client.query(
    `SELECT * FROM appointments WHERE raw_sheet_uuid = $1 LIMIT 1${lockClause}`,
    [value]
  );
  if (bySheet.rowCount > 0) return bySheet.rows[0];

  return null;
}

function inferTreatmentCode(raw) {
  const text = String(raw || '').toLowerCase();
  if (text.includes('smooth')) return 'smooth';
  if (text.includes('renew')) return 'glam_renew';
  if (text.includes('glam')) return 'glam_renew';
  if (text.includes('acne')) return 'expert';
  if (text.includes('expert')) return 'expert';
  return null;
}

async function resolvePackageIdFromTreatmentItem(client, treatmentItemText) {
  return resolvePackageIdForBooking(client, {
    explicitPackageId: '',
    treatmentItemText,
  });
}

async function ensureActiveCustomerPackage(client, { customerId, packageId, note }) {
  if (!customerId || !packageId) return null;

  const existing = await client.query(
    `
      SELECT id
      FROM customer_packages
      WHERE customer_id = $1
        AND package_id = $2
        AND LOWER(status) = 'active'
      ORDER BY purchased_at DESC
      LIMIT 1
    `,
    [customerId, packageId]
  );

  if (existing.rowCount > 0) return existing.rows[0].id;

  const inserted = await client.query(
    `
      INSERT INTO customer_packages (customer_id, package_id, status, purchased_at, note)
      VALUES ($1, $2, 'active', now(), $3)
      RETURNING id
    `,
    [customerId, packageId, note || 'auto:sync']
  );

  return inserted.rows[0]?.id || null;
}

async function getPackageUsageCounts(client, customerPackageId) {
  const usageCounts = await client.query(
    `
      SELECT
        COUNT(*)::int AS sessions_used,
        COUNT(*) FILTER (WHERE used_mask IS TRUE)::int AS mask_used,
        COALESCE(MAX(session_no), 0)::int AS last_session_no
      FROM package_usages
      WHERE customer_package_id = $1
    `,
    [customerPackageId]
  );

  const row = usageCounts.rows[0] || {};
  return {
    sessions_used: toNonNegativeInt(row.sessions_used),
    mask_used: toNonNegativeInt(row.mask_used),
    last_session_no: toNonNegativeInt(row.last_session_no),
  };
}

async function syncCustomerPackageContinuityStatus(client, customerPackageId, sessionsRemaining) {
  const statusResult = await client.query(
    `
      SELECT status
      FROM customer_packages
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
    `,
    [customerPackageId]
  );

  if (statusResult.rowCount === 0) return '';
  const currentStatus = normalizeText(statusResult.rows[0]?.status);
  const nextStatus = deriveContinuousPackageStatus(currentStatus, sessionsRemaining);

  if (nextStatus && nextStatus !== String(currentStatus || '').trim()) {
    await client.query(
      `
        UPDATE customer_packages
        SET status = $2
        WHERE id = $1
      `,
      [customerPackageId, nextStatus]
    );
  }

  return nextStatus || currentStatus;
}

async function buildPackageSnapshot(client, customerPackageId) {
  const pkgResult = await client.query(
    `
      SELECT
        cp.id AS customer_package_id,
        cp.status AS customer_package_status,
        p.code AS package_code,
        p.title AS package_title,
        p.sessions_total,
        p.mask_total
      FROM customer_packages cp
      JOIN packages p ON p.id = cp.package_id
      WHERE cp.id = $1
      LIMIT 1
    `,
    [customerPackageId]
  );

  if (pkgResult.rowCount === 0) return null;
  const pkg = pkgResult.rows[0];
  const counts = await getPackageUsageCounts(client, customerPackageId);
  const remaining = computePackageRemaining({
    sessionsTotal: pkg.sessions_total,
    sessionsUsed: counts.sessions_used,
    maskTotal: pkg.mask_total,
    maskUsed: counts.mask_used,
  });

  return {
    customer_package_id: customerPackageId,
    status: normalizeText(pkg.customer_package_status) || 'active',
    package_code: pkg.package_code || null,
    package_title: pkg.package_title || null,
    sessions_total: remaining.sessions_total,
    sessions_used: remaining.sessions_used,
    sessions_remaining: remaining.sessions_remaining,
    mask_total: remaining.mask_total,
    mask_used: remaining.mask_used,
    mask_remaining: remaining.mask_remaining,
    last_session_no: counts.last_session_no,
  };
}

async function resolveDefaultSmoothOneOffPackageId(client) {
  const result = await client.query(
    `
      SELECT id
      FROM packages
      WHERE LOWER(COALESCE(code, '')) LIKE 'smooth%'
        AND COALESCE(sessions_total, 0) = 1
      ORDER BY price_thb ASC NULLS LAST, id ASC
      LIMIT 1
    `
  );

  return result.rowCount > 0 ? result.rows[0].id : null;
}

async function getAppointmentTreatmentPlanFromEvents(client, appointmentId) {
  const result = await client.query(
    `
      SELECT
        ae.id,
        ae.event_type,
        ae.event_at,
        ae.meta
      FROM appointment_events ae
      WHERE ae.appointment_id = $1
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
      ORDER BY ae.event_at DESC NULLS LAST, ae.id DESC
    `,
    [appointmentId]
  );

  const resolved = resolveAppointmentFields(result.rows || []);
  return {
    treatmentItemText: normalizeText(resolved.treatment_item_text),
    treatmentPlanMode: normalizeText(resolved.treatment_plan_mode),
    packageId: normalizeText(resolved.package_id),
  };
}

export async function ensureAppointmentFromSheet(req, res) {
  const sheetUuid = String(req.params?.sheetUuid || '').trim();
  if (!UUID_PATTERN.test(sheetUuid)) {
    return res.status(400).json({ ok: false, error: 'Invalid sheet UUID' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sheetResult = await client.query(
      `
        SELECT
          sheet_uuid,
          TO_CHAR(visit_date, 'YYYY-MM-DD') AS visit_date,
          visit_time_text,
          customer_full_name,
          phone_raw,
          email_or_lineid,
          treatment_item_text,
          staff_name
        FROM sheet_visits_raw
        WHERE sheet_uuid = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [sheetUuid]
    );

    if (sheetResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Booking row not found' });
    }

    const sheet = sheetResult.rows[0];

    const phone = normalizePhone(sheet.phone_raw);
    const lineUserId = phone ? `phone:${phone}` : `sheet:${sheetUuid}`;

    const existingAppointment = await client.query(
      'SELECT * FROM appointments WHERE raw_sheet_uuid = $1 LIMIT 1',
      [sheetUuid]
    );

    let appointment = existingAppointment.rowCount > 0 ? existingAppointment.rows[0] : null;
    let customerId = appointment?.customer_id || null;

    if (!customerId && phone) {
      const identity = await client.query(
        `
          SELECT customer_id
          FROM customer_identities
          WHERE provider = 'PHONE'
            AND provider_user_id = $1
          LIMIT 1
        `,
        [phone]
      );
      if (identity.rowCount > 0) {
        customerId = identity.rows[0].customer_id;
      }
    }

    if (!customerId) {
      const createdCustomer = await client.query(
        'INSERT INTO customers (id, full_name, created_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id',
        [sheet.customer_full_name || '-']
      );
      const newCustomerId = createdCustomer.rows[0].id;

      if (phone) {
        try {
          await client.query(
            `
              INSERT INTO customer_identities
                (id, customer_id, provider, provider_user_id, is_active, created_at)
              VALUES
                (gen_random_uuid(), $1, 'PHONE', $2, true, now())
            `,
            [newCustomerId, phone]
          );
          customerId = newCustomerId;
        } catch (error) {
          if (error?.code === '23505') {
            const existing = await client.query(
              `
                SELECT customer_id
                FROM customer_identities
                WHERE provider = 'PHONE'
                  AND provider_user_id = $1
                LIMIT 1
              `,
              [phone]
            );
            customerId = existing.rows[0]?.customer_id || null;
            // Clean up the newly created customer row if identity already exists elsewhere.
            await client.query('DELETE FROM customers WHERE id = $1', [newCustomerId]);
          } else {
            throw error;
          }
        }
      } else {
        customerId = newCustomerId;
      }
    }

    if (!customerId) {
      await client.query('ROLLBACK');
      return res.status(422).json({ ok: false, error: 'Unable to resolve customer' });
    }

    await ensureLineUserRow(client, {
      lineUserId,
      displayName: sheet.customer_full_name || safeDisplayName(req.user),
      customerId,
    });

    if (appointment && !appointment.customer_id && customerId) {
      const updated = await client.query(
        `
          UPDATE appointments
          SET customer_id = $2,
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [appointment.id, customerId]
      );
      if (updated.rowCount > 0) {
        appointment = updated.rows[0];
      }
    }

    // Auto-create a customer package for course-style sheet entries so staff can deduct usage.
    const inferredPackageId = await resolvePackageIdFromTreatmentItem(client, sheet.treatment_item_text);
    const packageStyleTreatment = isPackageStyleTreatmentText(sheet.treatment_item_text);
    if (packageStyleTreatment && !inferredPackageId) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        ok: false,
        error: 'package_id is required for package-style treatment',
      });
    }

    const inferredCustomerPackageId = inferredPackageId
      ? await ensureActiveCustomerPackage(client, {
        customerId,
        packageId: inferredPackageId,
        note: sheetUuid ? `auto:sheet:${sheetUuid}` : 'auto:sheet',
      })
      : null;

    if (appointment) {
      await client.query('COMMIT');
      return res.json({ ok: true, appointment });
    }

    const timeHHMM = parseVisitTimeToHHMM(sheet.visit_time_text);
    if (!sheet.visit_date || !timeHHMM) {
      await client.query('ROLLBACK');
      return res.status(422).json({ ok: false, error: 'Invalid visit date/time' });
    }

    const treatmentCode = inferTreatmentCode(sheet.treatment_item_text);
    if (!treatmentCode) {
      await client.query('ROLLBACK');
      return res.status(422).json({ ok: false, error: 'Unable to infer treatment' });
    }

    const treatmentResult = await client.query(
      'SELECT id FROM treatments WHERE code = $1 LIMIT 1',
      [treatmentCode]
    );
    if (treatmentResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(422).json({ ok: false, error: 'Treatment not found' });
    }

    const treatmentId = treatmentResult.rows[0].id;
    const scheduledAt = `${sheet.visit_date}T${timeHHMM}:00+07:00`;

    const insertResult = await client.query(
      `
        INSERT INTO appointments (
          customer_id,
          line_user_id,
          treatment_id,
          branch_id,
          scheduled_at,
          status,
          source,
          raw_sheet_uuid
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          'booked',
          'SHEET',
          $6
        )
        RETURNING *
      `,
      [customerId, lineUserId, treatmentId, DEFAULT_BRANCH_ID, scheduledAt, sheetUuid]
    );

    appointment = insertResult.rows[0];

    const sheetCreateEventMeta = {
      source: 'sheet',
      raw_sheet_uuid: sheetUuid,
      staff_name: normalizeText(sheet.staff_name) || safeDisplayName(req.user),
      staff_user_id: req.user?.id || null,
      staff_display_name: safeDisplayName(req.user),
      treatment_item_text: normalizeText(sheet.treatment_item_text) || null,
      treatment_plan_mode: inferredPackageId ? 'package' : null,
      package_id: inferredPackageId || null,
      customer_package_id: inferredCustomerPackageId || null,
    };
    assertEventStaffIdentity(sheetCreateEventMeta, 'ensureAppointmentFromSheet');

    await client.query(
      `
        INSERT INTO appointment_events (id, appointment_id, event_type, event_at, actor, note, meta)
        VALUES (gen_random_uuid(), $1, 'created', now(), 'staff', NULL, $2::jsonb)
      `,
      [
        appointment.id,
        JSON.stringify(sheetCreateEventMeta),
      ]
    );

    await client.query('COMMIT');
    return res.json({ ok: true, appointment });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.status) {
      return res.status(error.status).json({
        ok: false,
        error: error.message,
        code: error?.code || null,
      });
    }
    if (error?.code === '23505') {
      return res.status(409).json({
        ok: false,
        error: 'Service usage already recorded for this appointment',
        code: error.code,
      });
    }
    console.error(error);
    const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    return res.status(500).json({
      ok: false,
      error: isProd ? 'Server error' : error?.message || 'Server error',
      code: isProd ? undefined : error?.code || null,
    });
  } finally {
    client.release();
  }
}

export async function syncAppointmentCourse(req, res) {
  const appointmentId = normalizeText(req.params?.id);
  if (!UUID_PATTERN.test(appointmentId)) {
    return res.status(400).json({ ok: false, error: 'Invalid appointment id' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const appointmentResult = await client.query(
      `
        SELECT
          a.id,
          a.customer_id,
          COALESCE(NULLIF(t.code, ''), '') AS treatment_code
        FROM appointments a
        LEFT JOIN treatments t ON t.id = a.treatment_id
        WHERE a.id = $1
        LIMIT 1
        FOR UPDATE OF a
      `,
      [appointmentId]
    );

    if (appointmentResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Appointment not found' });
    }

    const appointment = appointmentResult.rows[0];
    const customerId = normalizeText(appointment.customer_id);
    if (!customerId) {
      await client.query('ROLLBACK');
      return res.status(422).json({ ok: false, error: 'Appointment has no customer' });
    }

    const plan = await getAppointmentTreatmentPlanFromEvents(client, appointmentId);

    let packageId = '';
    if (UUID_PATTERN.test(plan.packageId)) {
      const packageExists = await client.query('SELECT id FROM packages WHERE id = $1 LIMIT 1', [
        plan.packageId,
      ]);
      if (packageExists.rowCount > 0) {
        packageId = plan.packageId;
      }
    }

    if (!packageId && plan.treatmentItemText) {
      packageId = (await resolvePackageIdFromTreatmentItem(client, plan.treatmentItemText)) || '';
    }

    if (!packageId && String(appointment.treatment_code || '').toLowerCase() === 'smooth') {
      packageId = (await resolveDefaultSmoothOneOffPackageId(client)) || '';
    }

    if (!packageId) {
      await client.query('COMMIT');
      return res.json({ ok: true, synced: false, reason: 'No package mapping found' });
    }

    const customerPackageId = await ensureActiveCustomerPackage(client, {
      customerId,
      packageId,
      note: `auto:sync:${appointmentId}`,
    });

    await client.query('COMMIT');
    return res.json({
      ok: true,
      synced: Boolean(customerPackageId),
      package_id: packageId,
      customer_package_id: customerPackageId || null,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.status) {
      return res.status(error.status).json({
        ok: false,
        error: error.message,
        code: error?.code || null,
      });
    }
    console.error(error);
    return res.status(500).json({ ok: false, error: 'Server error' });
  } finally {
    client.release();
  }
}

export async function completeAppointment(req, res) {
  const appointmentId = String(req.params?.id || '').trim();
  const customerPackageId =
    typeof req.body?.customer_package_id === 'string' ? req.body.customer_package_id.trim() : '';
  const legacyUsedMask = Boolean(req.body?.used_mask);
  const rawAppointmentAddonCode = normalizeText(
    typeof req.body?.appointment_addon_code === 'string'
      ? req.body.appointment_addon_code
      : typeof req.body?.addon_code === 'string'
        ? req.body.addon_code
        : ''
  );
  let appointmentAddonCode = '';
  let deductSessions = 1;
  let deductMask = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const staffId = await ensureStaffRow(client, req.user);

    const appointment = await resolveAppointment(client, appointmentId, { forUpdate: true });
    if (!appointment) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Appointment not found' });
    }

    const currentStatus = String(appointment.status || '').toLowerCase();
    if (shouldShortCircuitCompletedAppointment(currentStatus)) {
      const usageResult = await client.query(
        `
          SELECT
            pu.id,
            pu.customer_package_id,
            pu.session_no,
            pu.used_mask
          FROM package_usages pu
          WHERE pu.appointment_id = $1
          ORDER BY pu.used_at DESC NULLS LAST, pu.id DESC
          LIMIT 1
        `,
        [appointment.id]
      );

      const usageRow = usageResult.rows[0] || null;
      const packageSnapshot = usageRow?.customer_package_id
        ? await buildPackageSnapshot(client, usageRow.customer_package_id)
        : null;
      const appointmentAddon = await getAppointmentAddonByAppointmentId(client, appointment.id);

      await client.query('COMMIT');
      return res.json({
        ok: true,
        data: {
          appointment_id: appointment.id,
          status: 'completed',
          already_completed: true,
          idempotent: true,
          usage: usageRow
            ? {
                customer_package_id: usageRow.customer_package_id,
                session_no: usageRow.session_no,
                used_mask: Boolean(usageRow.used_mask),
              }
            : null,
          appointment_addon: appointmentAddon,
          package: packageSnapshot,
          remaining: packageSnapshot
            ? {
                sessions_remaining: packageSnapshot.sessions_remaining,
                mask_remaining: packageSnapshot.mask_remaining,
              }
            : null,
        },
      });
    }

    if (!canMutateFromStatus(currentStatus)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: `Cannot complete appointment in status: ${currentStatus}` });
    }

    try {
      deductSessions = parseDeductSessions(req.body?.deduct_sessions);
      const explicitDeductMask = parseOptionalInteger(req.body?.deduct_mask, 'deduct_mask');
      appointmentAddonCode = resolveRequestedAppointmentAddonCode({
        appointmentAddonCode: rawAppointmentAddonCode,
        usedMask: legacyUsedMask,
        deductMask: explicitDeductMask,
      });
      deductMask = appointmentAddonCode
        ? getAppointmentAddonDeductMask(appointmentAddonCode)
        : parseDeductMask(req.body?.deduct_mask, { usedMask: legacyUsedMask });
    } catch (error) {
      await client.query('ROLLBACK');
      return res.status(error?.status || 400).json({
        ok: false,
        error: error?.message || 'Invalid deduction payload',
        code: error?.code || null,
      });
    }

    if (!appointment.customer_id) {
      await client.query('ROLLBACK');
      return res.status(422).json({ ok: false, error: 'Appointment missing customer_id' });
    }

    const existingUsage = await client.query(
      'SELECT id FROM package_usages WHERE appointment_id = $1 LIMIT 1',
      [appointment.id]
    );
    if (existingUsage.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'Service usage already recorded for this appointment' });
    }

    if (!customerPackageId) {
      if (deductMask > 0 || deductSessions !== 1) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          ok: false,
          error: 'Cannot deduct sessions/mask without selecting a package',
        });
      }

      await client.query(
        `
          UPDATE appointments
          SET status = 'completed',
              updated_at = now()
          WHERE id = $1
        `,
        [appointment.id]
      );

      let appointmentAddon = null;
      if (appointmentAddonCode) {
        appointmentAddon = await upsertAppointmentAddonSelection(client, {
          appointmentId: appointment.id,
          addonCode: appointmentAddonCode,
        });
      } else {
        await clearAppointmentAddonSelection(client, appointment.id);
      }

      const completeOneOffEventMeta = {
        kind: 'one_off',
        staff_id: staffId,
        staff_user_id: req.user?.id || null,
        staff_display_name: safeDisplayName(req.user),
        treatment_id: appointment.treatment_id || null,
        raw_sheet_uuid: appointment.raw_sheet_uuid || null,
        appointment_addon_code: appointmentAddon?.topping_code || null,
        appointment_addon_kind: appointmentAddon?.addon_kind || null,
        appointment_addon_label: appointmentAddon?.label || null,
        appointment_addon_amount_thb: appointmentAddon?.amount_thb || 0,
      };
      assertEventStaffIdentity(completeOneOffEventMeta, 'completeAppointment/one_off');

      await client.query(
        `
          INSERT INTO appointment_events (id, appointment_id, event_type, event_at, actor, note, meta)
          VALUES (gen_random_uuid(), $1, 'redeemed', now(), 'staff', NULL, $2::jsonb)
        `,
        [
          appointment.id,
          JSON.stringify(completeOneOffEventMeta),
        ]
      );

      await client.query('COMMIT');
      return res.json({
        ok: true,
        data: {
          appointment_id: appointment.id,
          status: 'completed',
          usage: null,
          appointment_addon: appointmentAddon,
        },
      });
    }

    if (!UUID_PATTERN.test(customerPackageId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'Invalid customer_package_id' });
    }

    const pkgResult = await client.query(
      `
        SELECT
          cp.id AS customer_package_id,
          cp.customer_id,
          cp.status AS customer_package_status,
          p.code AS package_code,
          p.title AS package_title,
          p.sessions_total,
          p.mask_total
        FROM customer_packages cp
        JOIN packages p ON p.id = cp.package_id
        WHERE cp.id = $1
        LIMIT 1
        FOR UPDATE OF cp
      `,
      [customerPackageId]
    );

    if (pkgResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Customer package not found' });
    }

    const pkg = pkgResult.rows[0];

    if (String(pkg.customer_id) !== String(appointment.customer_id)) {
      await client.query('ROLLBACK');
      return res.status(422).json({ ok: false, error: 'Package does not belong to this customer' });
    }

    if (String(pkg.customer_package_status || '').toLowerCase() !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'Package is not active' });
    }

    const totals = {
      sessions_total: Number(pkg.sessions_total) || 0,
      mask_total: Number(pkg.mask_total) || 0,
    };

    const counts = await getPackageUsageCounts(client, customerPackageId);
    const remainingBefore = computePackageRemaining({
      sessionsTotal: totals.sessions_total,
      sessionsUsed: counts.sessions_used,
      maskTotal: totals.mask_total,
      maskUsed: counts.mask_used,
    });

    if (remainingBefore.sessions_remaining <= 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'No remaining sessions for this package' });
    }

    if (deductMask > 0 && totals.mask_total <= 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'This package has no mask allowance' });
    }

    if (deductMask > remainingBefore.mask_remaining) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        ok: false,
        error: `Requested deduct_mask (${deductMask}) exceeds remaining masks (${remainingBefore.mask_remaining})`,
      });
    }

    const nextSessionNo = Number(counts.last_session_no || 0) + 1;
    const usedMaskFlag = deductMask === 1;

    const usageInsert = await client.query(
      `
        INSERT INTO package_usages
          (id, customer_package_id, appointment_id, session_no, used_mask, used_at, staff_id, note)
        VALUES
          (gen_random_uuid(), $1, $2, $3, $4, now(), $5, NULL)
        RETURNING id, session_no, used_mask
      `,
      [customerPackageId, appointment.id, nextSessionNo, usedMaskFlag, staffId]
    );

    await client.query(
      `
        UPDATE appointments
        SET status = 'completed',
            updated_at = now()
        WHERE id = $1
      `,
      [appointment.id]
    );

    const insertedUsage = usageInsert.rows[0] || null;
    const remainingAfter = computePackageRemaining({
      sessionsTotal: totals.sessions_total,
      sessionsUsed: counts.sessions_used + 1,
      maskTotal: totals.mask_total,
      maskUsed: counts.mask_used + (usedMaskFlag ? 1 : 0),
    });
    const packageStatusAfter = await syncCustomerPackageContinuityStatus(
      client,
      customerPackageId,
      remainingAfter.sessions_remaining
    );
    let appointmentAddon = null;
    if (appointmentAddonCode) {
      appointmentAddon = await upsertAppointmentAddonSelection(client, {
        appointmentId: appointment.id,
        addonCode: appointmentAddonCode,
        customerPackageId: usedMaskFlag ? customerPackageId : '',
      });
    } else {
      await clearAppointmentAddonSelection(client, appointment.id);
    }

    const completePackageEventMeta = {
      staff_id: staffId,
      staff_user_id: req.user?.id || null,
      staff_display_name: safeDisplayName(req.user),
      customer_package_id: customerPackageId,
      package_code: pkg.package_code,
      session_no: nextSessionNo,
      sessions_deducted: 1,
      mask_deducted: usedMaskFlag ? 1 : 0,
      used_mask: usedMaskFlag,
      usage_id: insertedUsage?.id || null,
      package_status_after: packageStatusAfter,
      remaining_sessions_after: remainingAfter.sessions_remaining,
      remaining_mask_after: remainingAfter.mask_remaining,
      appointment_addon_code: appointmentAddon?.topping_code || null,
      appointment_addon_kind: appointmentAddon?.addon_kind || null,
      appointment_addon_label: appointmentAddon?.label || null,
      appointment_addon_amount_thb: appointmentAddon?.amount_thb || 0,
    };
    assertEventStaffIdentity(completePackageEventMeta, 'completeAppointment/package');

    await client.query(
      `
        INSERT INTO appointment_events (id, appointment_id, event_type, event_at, actor, note, meta)
        VALUES (gen_random_uuid(), $1, 'redeemed', now(), 'staff', NULL, $2::jsonb)
      `,
      [
        appointment.id,
        JSON.stringify(completePackageEventMeta),
      ]
    );

    await client.query('COMMIT');
    return res.json({
      ok: true,
      data: {
        appointment_id: appointment.id,
        status: 'completed',
        usage: {
          customer_package_id: customerPackageId,
          package_code: pkg.package_code,
          session_no: nextSessionNo,
          sessions_deducted: 1,
          mask_deducted: usedMaskFlag ? 1 : 0,
          used_mask: usedMaskFlag,
        },
        appointment_addon: appointmentAddon,
        package: {
          customer_package_id: customerPackageId,
          status: packageStatusAfter || pkg.customer_package_status || 'active',
          package_code: pkg.package_code || null,
          package_title: pkg.package_title || null,
          sessions_total: remainingAfter.sessions_total,
          sessions_used: remainingAfter.sessions_used,
          sessions_remaining: remainingAfter.sessions_remaining,
          mask_total: remainingAfter.mask_total,
          mask_used: remainingAfter.mask_used,
          mask_remaining: remainingAfter.mask_remaining,
        },
        remaining: {
          sessions_remaining: remainingAfter.sessions_remaining,
          mask_remaining: remainingAfter.mask_remaining,
        },
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.status) {
      return res.status(error.status).json({
        ok: false,
        error: error.message,
        code: error?.code || null,
      });
    }
    console.error(error);
    const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    return res.status(500).json({
      ok: false,
      error: isProd ? 'Server error' : error?.message || 'Server error',
      code: isProd ? undefined : error?.code || null,
    });
  } finally {
    client.release();
  }
}

async function setAppointmentStatus({ req, res, nextStatus, eventType }) {
  // Course-deduction policy:
  // - completed: handled in completeAppointment() and can create package_usages.
  // - no_show / cancelled: status-only update here (no package usage deduction).
  const appointmentId = String(req.params?.id || '').trim();
  const noteRaw = typeof req.body?.note === 'string'
    ? req.body.note.trim()
    : typeof req.body?.reason === 'string'
      ? req.body.reason.trim()
      : '';
  const note = noteRaw || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const eventStaffId = await ensureStaffRow(client, req.user);

    const appointment = await resolveAppointment(client, appointmentId, { forUpdate: true });
    if (!appointment) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Appointment not found' });
    }

    const currentStatus = String(appointment.status || '').toLowerCase();
    if (!canMutateFromStatus(currentStatus)) {
      await client.query('ROLLBACK');
      return res
        .status(409)
        .json({ ok: false, error: `Cannot change status from: ${currentStatus}` });
    }

    await client.query(
      `
        UPDATE appointments
        SET status = $2,
            updated_at = now()
        WHERE id = $1
      `,
      [appointment.id, nextStatus]
    );

    const statusEventMeta = {
      previous_status: currentStatus,
      next_status: nextStatus,
      staff_id: eventStaffId,
      staff_user_id: req.user?.id || null,
      staff_display_name: safeDisplayName(req.user),
      note,
    };
    assertEventStaffIdentity(statusEventMeta, `setAppointmentStatus/${eventType}`);

    await client.query(
      `
        INSERT INTO appointment_events (id, appointment_id, event_type, event_at, actor, note, meta)
        VALUES (gen_random_uuid(), $1, $2, now(), 'staff', $3, $4::jsonb)
      `,
      [
        appointment.id,
        eventType,
        note,
        JSON.stringify(statusEventMeta),
      ]
    );

    await client.query('COMMIT');
    return res.json({ ok: true, data: { appointment_id: appointment.id, status: nextStatus } });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.status) {
      return res.status(error.status).json({
        ok: false,
        error: error.message,
        code: error?.code || null,
      });
    }
    console.error(error);
    const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    return res.status(500).json({
      ok: false,
      error: isProd ? 'Server error' : error?.message || 'Server error',
      code: isProd ? undefined : error?.code || null,
    });
  } finally {
    client.release();
  }
}

export async function cancelAppointment(req, res) {
  return setAppointmentStatus({
    req,
    res,
    nextStatus: 'cancelled',
    eventType: 'cancelled',
  });
}

export async function noShowAppointment(req, res) {
  return setAppointmentStatus({
    req,
    res,
    nextStatus: 'no_show',
    eventType: 'no_show',
  });
}

export async function revertAppointment(req, res) {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  const appointmentId = String(req.params?.id || '').trim();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const eventStaffId = await ensureStaffRow(client, req.user);

    const appointment = await resolveAppointment(client, appointmentId, { forUpdate: true });
    if (!appointment) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Appointment not found' });
    }

    const currentStatus = String(appointment.status || '').toLowerCase();
    const usageResult = await client.query(
      `
        SELECT id, customer_package_id, session_no, used_mask
        FROM package_usages
        WHERE appointment_id = $1
        ORDER BY session_no ASC, used_at ASC, id ASC
        FOR UPDATE
      `,
      [appointment.id]
    );
    const usageRows = usageResult.rows || [];
    const hasUsageRows = usageRows.length > 0;
    const canRevertBookedWithUsage = currentStatus === 'booked' && hasUsageRows;
    if (!canRevertFromStatus(currentStatus) && !canRevertBookedWithUsage) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        ok: false,
        error: `Only ${Array.from(REVERTABLE_STATUSES).join(', ')} appointments can be reverted`,
      });
    }

    // Revert policy:
    // - completed: undo all package usages recorded by this appointment.
    // - booked with lingering usage (inconsistent admin edits): allow cleanup.
    // - no_show / cancelled(canceled): status-only revert unless lingering usage exists.
    if (hasUsageRows) {
      await client.query('DELETE FROM package_usages WHERE appointment_id = $1', [appointment.id]);
    }
    const clearedAppointmentAddon = await clearAppointmentAddonSelection(client, appointment.id);

    await client.query(
      `
        UPDATE appointments
        SET status = $2,
            updated_at = now()
        WHERE id = $1
      `,
      [appointment.id, REVERT_TARGET_STATUS]
    );

    const revertedUsageIds = usageRows.map((row) => row.id).filter(Boolean);
    const revertedPackageIds = [...new Set(usageRows.map((row) => row.customer_package_id).filter(Boolean))];
    const revertedMaskCount = usageRows.filter((row) => row.used_mask).length;
    const firstSessionNo = usageRows[0]?.session_no ?? null;
    const lastSessionNo = usageRows.length > 0 ? usageRows[usageRows.length - 1]?.session_no ?? null : null;
    const restoredPackages = [];

    for (const packageId of revertedPackageIds) {
      const snapshot = await buildPackageSnapshot(client, packageId);
      if (!snapshot) continue;
      const syncedStatus = await syncCustomerPackageContinuityStatus(
        client,
        packageId,
        snapshot.sessions_remaining
      );
      restoredPackages.push({
        ...snapshot,
        status: syncedStatus || snapshot.status,
      });
    }

    const revertEventMeta = {
      action: 'revert',
      staff_id: eventStaffId,
      staff_user_id: req.user?.id || null,
      staff_display_name: safeDisplayName(req.user),
      previous_status: currentStatus,
      next_status: REVERT_TARGET_STATUS,
      reverted_usage_ids: revertedUsageIds,
      reverted_usage_count: revertedUsageIds.length,
      reverted_mask_count: revertedMaskCount,
      reverted_appointment_addon: clearedAppointmentAddon.addon,
      reverted_appointment_addon_count: clearedAppointmentAddon.deleted ? 1 : 0,
      customer_package_id: revertedPackageIds.length === 1 ? revertedPackageIds[0] : null,
      customer_package_ids: revertedPackageIds,
      restored_packages: restoredPackages,
      session_no_start: firstSessionNo,
      session_no_end: lastSessionNo,
    };
    assertEventStaffIdentity(revertEventMeta, 'revertAppointment');

    await client.query(
      `
        INSERT INTO appointment_events (id, appointment_id, event_type, event_at, actor, note, meta)
        VALUES (gen_random_uuid(), $1, 'redeemed', now(), 'staff', 'revert status', $2::jsonb)
      `,
      [
        appointment.id,
        JSON.stringify(revertEventMeta),
      ]
    );

    await client.query('COMMIT');
    return res.json({
      ok: true,
      data: {
        appointment_id: appointment.id,
        status: REVERT_TARGET_STATUS,
        restored_packages: restoredPackages,
        reverted_appointment_addon: clearedAppointmentAddon.addon,
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.status) {
      return res.status(error.status).json({
        ok: false,
        error: error.message,
        code: error?.code || null,
      });
    }
    console.error(error);
    const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    return res.status(500).json({
      ok: false,
      error: isProd ? 'Server error' : error?.message || 'Server error',
      code: isProd ? undefined : error?.code || null,
    });
  } finally {
    client.release();
  }
}
