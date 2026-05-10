import { clearAppointmentAddonSelection } from './appointmentAddonService.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BOOKED_STATUS = 'booked';

const COMPLETED_STATUS = 'completed';
const ADMIN_PATCH_STATUSES = new Set([
  'booked',
  'completed',
  'cancelled',
  'no_show',
  'rescheduled',
  'ensured',
  'confirmed',
  'check_in',
  'checked_in',
  'pending',
]);

function normalizeStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'canceled') return 'cancelled';
  return normalized;
}

function buildError(message, status = 400, code = '') {
  const error = new Error(message);
  error.status = status;
  if (code) {
    error.code = code;
  }
  return error;
}

async function loadAppointmentForUpdate(client, appointmentId) {
  const result = await client.query(
    `
      SELECT id, status
      FROM appointments
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
    `,
    [appointmentId]
  );
  if (result.rowCount === 0) {
    throw buildError('Appointment not found', 404);
  }
  return result.rows[0];
}

async function loadUsageRowsForUpdate(client, appointmentId) {
  const result = await client.query(
    `
      SELECT id, customer_package_id, session_no, used_mask
      FROM package_usages
      WHERE appointment_id = $1
      ORDER BY session_no ASC, used_at ASC, id ASC
      FOR UPDATE
    `,
    [appointmentId]
  );
  return result.rows || [];
}

async function countUsageRows(client, appointmentId) {
  const result = await client.query(
    `
      SELECT COUNT(*)::int AS usage_count
      FROM package_usages
      WHERE appointment_id = $1
    `,
    [appointmentId]
  );
  return Number(result.rows[0]?.usage_count) || 0;
}

async function updateAppointmentStatus(client, appointmentId, nextStatus) {
  const result = await client.query(
    `
      UPDATE appointments
      SET status = $2,
          updated_at = now()
      WHERE id = $1
      RETURNING id, status, updated_at
    `,
    [appointmentId, nextStatus]
  );
  if (result.rowCount === 0) {
    throw buildError('Appointment not found', 404);
  }
  return result.rows[0];
}

async function fetchAppointmentSnapshot(client, appointmentId) {
  const result = await client.query(
    `
      SELECT id, status, updated_at
      FROM appointments
      WHERE id = $1
      LIMIT 1
    `,
    [appointmentId]
  );
  if (result.rowCount === 0) {
    throw buildError('Appointment not found', 404);
  }
  return result.rows[0];
}

function shouldRollbackUsageForStatus(status) {
  return normalizeStatus(status) === BOOKED_STATUS;
}

export async function adminPatchAppointmentStatusInTransaction({
  client,
  appointmentId,
  patch,
  actorUserId,
}) {
  if (!client || typeof client.query !== 'function') {
    throw buildError('Missing database client', 500);
  }

  const cleanAppointmentId = String(appointmentId || '').trim();
  if (!UUID_PATTERN.test(cleanAppointmentId)) {
    throw buildError('Invalid appointment id', 400);
  }

  const nextStatus = normalizeStatus(patch?.status);
  if (!nextStatus) {
    throw buildError('Missing status patch value', 400);
  }
  if (!ADMIN_PATCH_STATUSES.has(nextStatus)) {
    throw buildError(
      'status must be one of booked|completed|cancelled|no_show|rescheduled|ensured|confirmed|check_in|checked_in|pending',
      400
    );
  }

  // Keep actor validation here so standalone service calls are auditable/guarded.
  if (!String(actorUserId || '').trim()) {
    throw buildError('Missing admin actor identity', 401);
  }

  const appointmentBefore = await loadAppointmentForUpdate(client, cleanAppointmentId);
  const usageRowsBefore = await loadUsageRowsForUpdate(client, cleanAppointmentId);
  const usageCountBefore = usageRowsBefore.length;

  let revertedUsageCount = 0;
  let revertedAddonCount = 0;
  if (shouldRollbackUsageForStatus(nextStatus) && usageCountBefore > 0) {
    const deleteResult = await client.query(
      `
        DELETE FROM package_usages
        WHERE appointment_id = $1
      `,
      [cleanAppointmentId]
    );
    revertedUsageCount = Number(deleteResult.rowCount) || 0;
  }
  if (shouldRollbackUsageForStatus(nextStatus)) {
    const clearedAddon = await clearAppointmentAddonSelection(client, cleanAppointmentId);
    revertedAddonCount = clearedAddon.deleted ? 1 : 0;
  }

  const currentStatus = normalizeStatus(appointmentBefore.status);
  if (currentStatus !== nextStatus) {
    await updateAppointmentStatus(client, cleanAppointmentId, nextStatus);
  }

  const usageCountAfter = await countUsageRows(client, cleanAppointmentId);
  if (shouldRollbackUsageForStatus(nextStatus) && usageCountAfter !== 0) {
    throw buildError(
      `Invariant violation: expected 0 package_usages for status ${nextStatus}, found ${usageCountAfter}`,
      409,
      'USAGE_INVARIANT_FAILED'
    );
  }

  const warnings = [];
  if (nextStatus !== BOOKED_STATUS && usageCountAfter === 0) {
    warnings.push(
      nextStatus === COMPLETED_STATUS
        ? 'Status is completed but no package usage is recorded. Use complete service flow to apply deduction.'
        : `Status is ${nextStatus} but no package usage is recorded.`
    );
  }

  const appointment = await fetchAppointmentSnapshot(client, cleanAppointmentId);
  return {
    appointment,
    beforeStatus: currentStatus,
    afterStatus: normalizeStatus(appointment.status),
    usageCountBefore,
    usageCountAfter,
    revertedUsageCount,
    revertedAddonCount,
    warnings,
  };
}

export async function adminPatchAppointmentStatus({
  appointmentId,
  patch,
  actorUserId,
  dbPool = null,
}) {
  const resolvedPool =
    dbPool ||
    (await import('../db.js').then((module) => module.pool));
  const client = await resolvedPool.connect();
  try {
    await client.query('BEGIN');
    const result = await adminPatchAppointmentStatusInTransaction({
      client,
      appointmentId,
      patch,
      actorUserId,
    });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback errors; original error should be surfaced.
    }
    throw error;
  } finally {
    client.release();
  }
}
