import { pool } from '../db.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function toInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function computeExpectations(currentRemaining, deducted) {
  if (deducted) {
    return {
      expectedIfNotDeducted: currentRemaining + 1,
      expectedIfAlreadyDeducted: currentRemaining,
    };
  }
  return {
    expectedIfNotDeducted: currentRemaining,
    expectedIfAlreadyDeducted: Math.max(currentRemaining - 1, 0),
  };
}

export async function checkAppointmentStatus(req, res) {
  const appointmentId = normalizeText(req.params?.id);
  if (!UUID_PATTERN.test(appointmentId)) {
    return res.status(400).json({ ok: false, error: 'Invalid appointment id' });
  }

  const client = await pool.connect();
  try {
    const appointmentResult = await client.query(
      `
        SELECT
          a.id,
          a.customer_id,
          a.treatment_id,
          a.status,
          a.created_at
        FROM appointments a
        WHERE a.id = $1
        LIMIT 1
      `,
      [appointmentId]
    );

    if (appointmentResult.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Appointment not found' });
    }

    const appointment = appointmentResult.rows[0];
    const usageRowsResult = await client.query(
      `
        SELECT
          pu.id,
          pu.customer_package_id,
          pu.used_mask,
          pu.used_at AS created_at
        FROM package_usages pu
        WHERE pu.appointment_id = $1
        ORDER BY pu.used_at ASC NULLS LAST, pu.id ASC
      `,
      [appointmentId]
    );
    const usageRows = usageRowsResult.rows || [];

    const usageEvents = [];
    const linkedPackageIdSet = new Set();
    for (const usage of usageRows) {
      const packageId = normalizeText(usage.customer_package_id);
      if (packageId) linkedPackageIdSet.add(packageId);
      usageEvents.push({
        type: 'session',
        created_at: usage.created_at || null,
      });
      if (Boolean(usage.used_mask)) {
        usageEvents.push({
          type: 'mask',
          created_at: usage.created_at || null,
        });
      }
    }

    const sessionUsageCount = usageEvents.filter((item) => item.type === 'session').length;
    const maskUsageCount = usageEvents.filter((item) => item.type === 'mask').length;

    if (sessionUsageCount > 1) {
      console.warn(
        `[debugAppointmentStatus] Multiple session usage rows detected for appointment ${appointmentId}: ${sessionUsageCount}`
      );
    }
    if (maskUsageCount > 1) {
      console.warn(
        `[debugAppointmentStatus] Multiple mask usage rows detected for appointment ${appointmentId}: ${maskUsageCount}`
      );
    }

    const linkedPackageIds = [...linkedPackageIdSet];
    let linkedPackages = [];
    if (linkedPackageIds.length > 0) {
      const linkedPackagesResult = await client.query(
        `
          WITH usage_totals AS (
            SELECT
              pu.customer_package_id,
              COUNT(*)::int AS sessions_used,
              COUNT(*) FILTER (WHERE pu.used_mask IS TRUE)::int AS mask_used
            FROM package_usages pu
            WHERE pu.customer_package_id = ANY($1::uuid[])
            GROUP BY pu.customer_package_id
          )
          SELECT
            cp.id AS customer_package_id,
            cp.package_id,
            p.sessions_total,
            (COALESCE(p.sessions_total, 0) - COALESCE(u.sessions_used, 0))::int AS sessions_remaining,
            p.mask_total,
            (COALESCE(p.mask_total, 0) - COALESCE(u.mask_used, 0))::int AS mask_remaining,
            cp.purchased_at
          FROM customer_packages cp
          JOIN packages p ON p.id = cp.package_id
          LEFT JOIN usage_totals u ON u.customer_package_id = cp.id
          WHERE cp.id = ANY($1::uuid[])
          ORDER BY cp.purchased_at DESC NULLS LAST, cp.id DESC
        `,
        [linkedPackageIds]
      );
      linkedPackages = linkedPackagesResult.rows || [];
    }

    for (const pkg of linkedPackages) {
      const sessionsRemaining = toInt(pkg.sessions_remaining);
      const maskRemaining = toInt(pkg.mask_remaining);
      if (sessionsRemaining < 0) {
        console.warn(
          `[debugAppointmentStatus] sessions_remaining < 0 for customer_package_id=${pkg.customer_package_id}: ${sessionsRemaining}`
        );
      }
      if (maskRemaining < 0) {
        console.warn(
          `[debugAppointmentStatus] mask_remaining < 0 for customer_package_id=${pkg.customer_package_id}: ${maskRemaining}`
        );
      }
    }

    const primaryPackage = linkedPackages[0] || null;
    const currentRemainingSessions = primaryPackage ? toInt(primaryPackage.sessions_remaining) : 0;
    const currentRemainingMask = primaryPackage ? toInt(primaryPackage.mask_remaining) : 0;

    const hasSessionBeenDeducted = sessionUsageCount > 0;
    const hasMaskBeenDeducted = maskUsageCount > 0;

    const sessionExpectations = computeExpectations(
      currentRemainingSessions,
      hasSessionBeenDeducted
    );
    const maskExpectations = computeExpectations(currentRemainingMask, hasMaskBeenDeducted);

    return res.json({
      ok: true,
      appointmentId: appointment.id,
      appointmentStatus: appointment.status,
      sessionDeducted: hasSessionBeenDeducted,
      maskDeducted: hasMaskBeenDeducted,
      remainingSessions: currentRemainingSessions,
      remainingMask: currentRemainingMask,
      expectedIfNotDeducted: {
        sessions: sessionExpectations.expectedIfNotDeducted,
        mask: maskExpectations.expectedIfNotDeducted,
      },
      expectedIfAlreadyDeducted: {
        sessions: sessionExpectations.expectedIfAlreadyDeducted,
        mask: maskExpectations.expectedIfAlreadyDeducted,
      },
      appointment: {
        id: appointment.id,
        customer_id: appointment.customer_id,
        treatment_id: appointment.treatment_id,
        status: appointment.status,
        created_at: appointment.created_at,
      },
      linkedPackages: linkedPackages.map((pkg) => ({
        package_id: pkg.package_id,
        sessions_total: toInt(pkg.sessions_total),
        sessions_remaining: toInt(pkg.sessions_remaining),
        mask_total: toInt(pkg.mask_total),
        mask_remaining: toInt(pkg.mask_remaining),
      })),
      usageRows: usageEvents,
    });
  } catch (error) {
    console.error('[debugAppointmentStatus] failed', error);
    return res.status(500).json({ ok: false, error: 'Server error' });
  } finally {
    client.release();
  }
}

