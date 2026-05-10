import { assertEventStaffIdentity } from './appointmentEventStaffGuard.js';
import {
  buildReceiptEvidenceSummary,
  insertAppointmentReceiptEvidence,
  parseOptionalReceiptEvidence,
} from './appointmentReceiptEvidenceService.js';
import { assertLiffReceiptPromoBookingAllowed } from '../config/liffReceiptPromoCampaign.js';
import {
  isPackageStyleTreatmentText,
  resolvePackageIdForBooking,
} from '../utils/resolvePackageIdForBooking.js';
import {
  DEFAULT_BRANCH_ID,
  normalizeBranchWriteValue,
  resolveCanonicalWriteBranchId,
} from '../utils/branchContract.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;

const STAFF_LINE_USER_ID = '__STAFF__';
const STAFF_SOURCE = 'WEB';
const ADMIN_ROLES = new Set(['admin', 'owner']);

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function requireText(value, fieldName) {
  const trimmed = normalizeText(value);
  if (!trimmed) {
    const err = new Error(`Missing required field: ${fieldName}`);
    err.status = 400;
    throw err;
  }
  return trimmed;
}

function normalizePhone(raw) {
  return normalizeText(raw).replace(/[^\d]/g, '');
}

function hasTimezoneOffset(value) {
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(value);
}

function requireIsoDatetimeWithTimezone(value) {
  const raw = requireText(value, 'scheduled_at');
  if (!hasTimezoneOffset(raw)) {
    const err = new Error('scheduled_at must include timezone offset (e.g. 2026-02-05T14:00:00+07:00)');
    err.status = 400;
    throw err;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    const err = new Error('scheduled_at must be a valid ISO datetime');
    err.status = 400;
    throw err;
  }
  return raw;
}

function requireFutureIsoDatetime(value) {
  const raw = requireIsoDatetimeWithTimezone(value);
  const parsed = new Date(raw);
  if (parsed.getTime() <= Date.now()) {
    const err = new Error('scheduled_at must be in the future');
    err.status = 400;
    throw err;
  }
  return raw;
}

function isAdminRole(roleName) {
  const role = String(roleName || '').trim().toLowerCase();
  return ADMIN_ROLES.has(role);
}

function parseOverridePayload(rawOverride) {
  if (rawOverride === null || rawOverride === undefined) return null;
  if (typeof rawOverride !== 'object' || Array.isArray(rawOverride)) {
    const err = new Error('override must be an object');
    err.status = 400;
    throw err;
  }

  const isOverride = rawOverride.is_override === true;
  const reason = normalizeText(rawOverride.reason) || 'ADMIN_OVERRIDE';
  const confirmedAt = normalizeText(rawOverride.confirmed_at);
  const violationsRaw = rawOverride.violations;
  const violations = Array.isArray(violationsRaw)
    ? violationsRaw.map((item) => normalizeText(item)).filter(Boolean)
    : [];

  if (isOverride) {
    if (!Array.isArray(violationsRaw) || violations.length === 0) {
      const err = new Error('override.violations must be a non-empty array');
      err.status = 400;
      throw err;
    }
    if (!confirmedAt) {
      const err = new Error('override.confirmed_at is required');
      err.status = 400;
      throw err;
    }
    const confirmedDate = new Date(confirmedAt);
    if (Number.isNaN(confirmedDate.getTime())) {
      const err = new Error('override.confirmed_at must be a valid ISO datetime');
      err.status = 400;
      throw err;
    }
  }

  return {
    isOverride,
    reason,
    confirmedAt,
    violations,
    snapshot: rawOverride,
  };
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

function toInvalidPayloadError(error) {
  if (error?.status) return error;
  const wrapped = new Error('Invalid request payload');
  wrapped.status = 400;
  wrapped.cause = error;
  return wrapped;
}

function normalizeKnownCreateError(error) {
  if (error?.status) return error;
  if (error?.code === '23503' && error?.constraint === 'appointments_line_user_id_fkey') {
    const wrapped = new Error('Unable to resolve system line_user_id for staff booking');
    wrapped.status = 422;
    wrapped.code = error.code;
    wrapped.constraint = error.constraint;
    return wrapped;
  }
  return error;
}

async function ensureActiveCustomerPackage(client, { customerId, packageId, note }) {
  if (!customerId || !packageId) return null;

  const existing = await client.query(
    `
      SELECT id
      FROM customer_packages
      WHERE customer_id = $1
        AND package_id = $2
        AND LOWER(COALESCE(status, '')) = 'active'
      ORDER BY purchased_at DESC NULLS LAST, id DESC
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
    [customerId, packageId, note || 'auto:staff']
  );

  return inserted.rows[0]?.id || null;
}

async function ensureStaffLineUserRow(client) {
  const result = await client.query(
    `
      INSERT INTO line_users (line_user_id, display_name, customer_id)
      VALUES ($1, $2, NULL)
      ON CONFLICT (line_user_id)
      DO UPDATE SET
        display_name = COALESCE(line_users.display_name, EXCLUDED.display_name)
      RETURNING line_user_id
    `,
    [STAFF_LINE_USER_ID, 'staff-booking']
  );

  return normalizeText(result.rows[0]?.line_user_id) || STAFF_LINE_USER_ID;
}

async function resolveOrCreateCustomerByPhone(client, { phoneDigits, fullName }) {
  const identity = await client.query(
    `
      SELECT customer_id
      FROM customer_identities
      WHERE provider = 'PHONE'
        AND provider_user_id = $1
        AND is_active = true
      LIMIT 1
    `,
    [phoneDigits]
  );

  if (identity.rowCount > 0) {
    const customerId = identity.rows[0].customer_id;
    if (fullName) {
      await client.query(
        `
          UPDATE customers
          SET full_name = $2
          WHERE id = $1
            AND COALESCE(full_name, '') <> $2
        `,
        [customerId, fullName]
      );
    }
    return customerId;
  }

  const createdCustomer = await client.query(
    'INSERT INTO customers (id, full_name, created_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id',
    [fullName || '-']
  );
  const newCustomerId = createdCustomer.rows[0]?.id;

  try {
    await client.query(
      `
        INSERT INTO customer_identities
          (id, customer_id, provider, provider_user_id, is_active, created_at)
        VALUES
          (gen_random_uuid(), $1, 'PHONE', $2, true, now())
      `,
      [newCustomerId, phoneDigits]
    );
    return newCustomerId;
  } catch (error) {
    if (error?.code !== '23505') {
      throw error;
    }

    const existing = await client.query(
      `
        SELECT customer_id
        FROM customer_identities
        WHERE provider = 'PHONE'
          AND provider_user_id = $1
          AND is_active = true
        LIMIT 1
      `,
      [phoneDigits]
    );

    const existingCustomerId = existing.rows[0]?.customer_id || null;
    await client.query('DELETE FROM customers WHERE id = $1', [newCustomerId]);
    return existingCustomerId;
  }
}

function parseCanonicalAppointmentBody({ body = {}, user }) {
  try {
    const overridePayload = parseOverridePayload(body?.override);
    const canApplyAdminOverride = Boolean(
      overridePayload?.isOverride && isAdminRole(user?.role_name)
    );
    const receiptEvidence = parseOptionalReceiptEvidence(body?.receipt_evidence);
    const parseScheduledAt = canApplyAdminOverride
      ? requireIsoDatetimeWithTimezone
      : requireFutureIsoDatetime;

    const scheduledAtInput = normalizeText(body?.scheduled_at);
    const visitDate = normalizeText(body?.visit_date);
    const visitTime = normalizeText(body?.visit_time_text);

    let scheduledAtRaw = '';
    if (scheduledAtInput) {
      scheduledAtRaw = parseScheduledAt(scheduledAtInput);
    } else {
      const vDate = requireText(visitDate, 'visit_date');
      const vTime = requireText(visitTime, 'visit_time_text');
      if (!DATE_PATTERN.test(vDate)) {
        const err = new Error('Invalid visit_date format. Use YYYY-MM-DD');
        err.status = 400;
        throw err;
      }
      if (!TIME_PATTERN.test(vTime)) {
        const err = new Error('Invalid visit_time_text format. Use HH:MM');
        err.status = 400;
        throw err;
      }
      scheduledAtRaw = parseScheduledAt(`${vDate}T${vTime}:00+07:00`);
    }

    const branchIdInput = normalizeBranchWriteValue(body?.branch_id) || '';
    if (receiptEvidence && !branchIdInput) {
      const err = new Error('branch_id is required when receipt_evidence is provided');
      err.status = 400;
      throw err;
    }
    const branchId = resolveCanonicalWriteBranchId(branchIdInput, {
      defaultValue: DEFAULT_BRANCH_ID,
    });
    if (!branchId) {
      const err = new Error('Missing required field: branch_id');
      err.status = 400;
      throw err;
    }

    const customerFullName = requireText(body?.customer_full_name, 'customer_full_name');

    const phoneRaw = normalizeText(body?.phone) || normalizeText(body?.phone_raw);
    const phoneDigits = normalizePhone(requireText(phoneRaw, 'phone'));
    if (phoneDigits.length < 9) {
      const err = new Error('Invalid phone');
      err.status = 400;
      throw err;
    }

    const emailOrLineid = normalizeText(body?.email_or_lineid);
    const staffName = normalizeText(body?.staff_name);
    const treatmentItemText = normalizeText(body?.treatment_item_text);

    const packageId = normalizeText(body?.package_id);
    if (packageId && !UUID_PATTERN.test(packageId)) {
      const err = new Error('Invalid package_id');
      err.status = 400;
      throw err;
    }

    let treatmentId = '';
    const treatmentIdRaw = normalizeText(body?.treatment_id);
    if (treatmentIdRaw) {
      if (!UUID_PATTERN.test(treatmentIdRaw)) {
        const err = new Error('Invalid treatment_id');
        err.status = 400;
        throw err;
      }
      treatmentId = treatmentIdRaw;
    } else if (treatmentItemText) {
      const inferred = inferTreatmentCode(treatmentItemText);
      if (!inferred) {
        const err = new Error('Unable to infer treatment_id from treatment_item_text');
        err.status = 422;
        throw err;
      }
      treatmentId = inferred;
    } else {
      const err = new Error('Missing required field: treatment_id');
      err.status = 400;
      throw err;
    }

    return {
      scheduledAtRaw,
      branchId,
      treatmentId,
      packageId,
      customerFullName,
      phoneDigits,
      emailOrLineid,
      staffName,
      treatmentItemText,
      receiptEvidence,
      overridePayload,
      canApplyAdminOverride,
      visitDate,
      visitTime,
    };
  } catch (error) {
    throw toInvalidPayloadError(error);
  }
}

function mergeEventMeta(baseMeta, eventMetaExtra) {
  if (!eventMetaExtra || typeof eventMetaExtra !== 'object' || Array.isArray(eventMetaExtra)) {
    return baseMeta;
  }
  return {
    ...baseMeta,
    ...eventMetaExtra,
  };
}

async function resolveDbPool(dbPool) {
  if (dbPool) return dbPool;
  const dbModule = await import('../db.js');
  return dbModule.pool;
}

export async function createCanonicalAppointmentFromBody({
  body = {},
  user,
  client: existingClient = null,
  dbPool = null,
  eventMetaExtra = null,
} = {}) {
  const payload = parseCanonicalAppointmentBody({ body, user });
  const ownClient = !existingClient;
  const resolvedDbPool = ownClient ? await resolveDbPool(dbPool) : null;
  const client = existingClient || (await resolvedDbPool.connect());

  try {
    if (ownClient) {
      await client.query('BEGIN');
    }

    let resolvedTreatmentId = null;
    let resolvedTreatmentCode = '';
    if (UUID_PATTERN.test(payload.treatmentId)) {
      const exists = await client.query('SELECT id, code FROM treatments WHERE id = $1 LIMIT 1', [
        payload.treatmentId,
      ]);
      if (exists.rowCount === 0) {
        const err = new Error('Treatment not found');
        err.status = 400;
        throw err;
      }
      resolvedTreatmentId = payload.treatmentId;
      resolvedTreatmentCode = normalizeText(exists.rows[0]?.code);
    } else {
      const byCode = await client.query('SELECT id, code FROM treatments WHERE code = $1 LIMIT 1', [
        payload.treatmentId,
      ]);
      if (byCode.rowCount === 0) {
        const err = new Error('Treatment not found');
        err.status = 422;
        throw err;
      }
      resolvedTreatmentId = byCode.rows[0].id;
      resolvedTreatmentCode = normalizeText(byCode.rows[0]?.code);
    }

    assertLiffReceiptPromoBookingAllowed({
      treatmentCode: resolvedTreatmentCode,
      receiptEvidence: payload.receiptEvidence,
    });

    if (!payload.canApplyAdminOverride) {
      const collision = await client.query(
        `
          SELECT id
          FROM appointments
          WHERE branch_id = $1
            AND scheduled_at = $2
            AND LOWER(COALESCE(status, '')) IN ('booked', 'rescheduled')
          LIMIT 1
        `,
        [payload.branchId, payload.scheduledAtRaw]
      );
      if (collision.rowCount > 0) {
        const err = new Error('Time slot is already booked');
        err.status = 409;
        throw err;
      }
    }

    const customerId = await resolveOrCreateCustomerByPhone(client, {
      phoneDigits: payload.phoneDigits,
      fullName: payload.customerFullName,
    });

    if (!customerId) {
      const err = new Error('Unable to resolve customer');
      err.status = 422;
      throw err;
    }

    const staffLineUserId = await ensureStaffLineUserRow(client);
    const resolvedPackageId = await resolvePackageIdForBooking(client, {
      explicitPackageId: payload.packageId,
      treatmentItemText: payload.treatmentItemText,
    });
    const packageStyleTreatment = isPackageStyleTreatmentText(payload.treatmentItemText);
    if (packageStyleTreatment && !resolvedPackageId) {
      const err = new Error('package_id is required for package-style treatment');
      err.status = 422;
      throw err;
    }
    const resolvedPlanMode = resolvedPackageId ? 'package' : '';

    const inserted = await client.query(
      `
        INSERT INTO appointments (
          line_user_id,
          treatment_id,
          branch_id,
          scheduled_at,
          status,
          customer_id,
          source
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          'booked',
          $5,
          $6
        )
        RETURNING id
      `,
      [staffLineUserId, resolvedTreatmentId, payload.branchId, payload.scheduledAtRaw, customerId, STAFF_SOURCE]
    );

    const appointmentId = inserted.rows[0]?.id;
    const customerPackageId = await ensureActiveCustomerPackage(client, {
      customerId,
      packageId: resolvedPackageId,
      note: appointmentId ? `auto:staff:${appointmentId}` : 'auto:staff',
    });
    const insertedReceiptEvidence = await insertAppointmentReceiptEvidence(client, {
      appointmentId,
      receiptEvidence: payload.receiptEvidence,
    });

    const createEventMeta = mergeEventMeta(
      {
        source: 'staff_create',
        scheduled_at: payload.scheduledAtRaw,
        branch_id: payload.branchId,
        treatment_id: resolvedTreatmentId,
        customer_id: customerId,
        customer_full_name: payload.customerFullName,
        phone: payload.phoneDigits,
        email_or_lineid: payload.emailOrLineid || null,
        staff_name:
          payload.staffName ||
          normalizeText(user?.display_name) ||
          normalizeText(user?.username) ||
          null,
        treatment_item_text: payload.treatmentItemText || null,
        treatment_plan_mode: resolvedPlanMode || null,
        package_id: resolvedPackageId || null,
        customer_package_id: customerPackageId || null,
        receipt_evidence_id: insertedReceiptEvidence?.id || null,
        receipt_evidence: buildReceiptEvidenceSummary(insertedReceiptEvidence),
        staff_user_id: user?.id || null,
        staff_username: normalizeText(user?.username) || null,
        staff_display_name: normalizeText(user?.display_name) || null,
      },
      eventMetaExtra
    );
    assertEventStaffIdentity(createEventMeta, 'createCanonicalAppointmentFromBody');

    await client.query(
      `
        INSERT INTO appointment_events (id, appointment_id, event_type, event_at, actor, note, meta)
        VALUES (gen_random_uuid(), $1, 'created', now(), 'staff', NULL, $2::jsonb)
      `,
      [appointmentId, JSON.stringify(createEventMeta)]
    );

    if (payload.canApplyAdminOverride) {
      const actorName =
        normalizeText(user?.display_name) || normalizeText(user?.username) || null;
      await client.query(
        `
          INSERT INTO appointment_override_logs (
            id,
            appointment_id,
            actor_user_id,
            actor_name,
            violations_json,
            override_reason,
            request_payload_snapshot
          )
          VALUES (gen_random_uuid(), $1, $2, $3, $4::jsonb, $5, $6::jsonb)
        `,
        [
          appointmentId,
          user?.id || null,
          actorName,
          JSON.stringify(payload.overridePayload?.violations || []),
          payload.overridePayload?.reason || 'ADMIN_OVERRIDE',
          JSON.stringify({
            scheduled_at: payload.scheduledAtRaw,
            visit_date: payload.visitDate || null,
            visit_time_text: payload.visitTime || null,
            branch_id: payload.branchId,
            receipt_evidence: payload.receiptEvidence,
            override: {
              is_override: true,
              reason: payload.overridePayload?.reason || 'ADMIN_OVERRIDE',
              violations: payload.overridePayload?.violations || [],
              confirmed_at: payload.overridePayload?.confirmedAt || null,
            },
          }),
        ]
      );
    }

    if (ownClient) {
      await client.query('COMMIT');
    }

    return {
      appointment_id: appointmentId,
      customer_id: customerId,
      customer_package_id: customerPackageId || null,
      receipt_evidence: insertedReceiptEvidence || null,
    };
  } catch (error) {
    if (ownClient) {
      await client.query('ROLLBACK');
    }
    throw normalizeKnownCreateError(error);
  } finally {
    if (ownClient) {
      client.release();
    }
  }
}

export function buildCanonicalAppointmentCreateErrorResponse(
  error,
  {
    isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production',
  } = {}
) {
  const normalized = normalizeKnownCreateError(error);
  if (normalized?.status) {
    const body = {
      ok: false,
      error: normalized.message,
    };
    if (normalized?.code) {
      body.code = normalized.code;
    }
    if (normalized?.constraint) {
      body.constraint = normalized.constraint;
    }
    return {
      status: normalized.status,
      body,
    };
  }

  return {
    status: 500,
    body: {
      ok: false,
      error: isProd ? 'Server error' : normalized?.message || 'Server error',
      code: isProd ? undefined : normalized?.code || null,
    },
  };
}
