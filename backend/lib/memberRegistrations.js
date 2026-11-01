"use strict";

const BRANCH_CODES = ["001", "003", "004", "005"];
const CAMPAIGN_START = "2026-11";

function registrationBranch(value) {
  return BRANCH_CODES.includes(value) ? value : null;
}

// Only explicit NEW-member writers call this, in their existing transaction.
// Imports, legacy adoption, profile edits and code reassignment never call it.
async function recordMemberRegistration(db, { memberId, source, branchCode, deviceId = null }) {
  await db.query(`INSERT INTO crm_reporting.member_registrations
    (member_id, source, branch_code, device_id)
    VALUES ($1, $2, $3, $4) ON CONFLICT (member_id) DO NOTHING`,
  [memberId, source, registrationBranch(branchCode), deviceId]);
}

function parseMonth(value) {
  if (typeof value !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(value) || value < CAMPAIGN_START) {
    throw Object.assign(new Error("Invalid registration month (minimum 2026-11)."), { status: 400 });
  }
  return value;
}

async function registrationCounts(db, query, now = new Date()) {
  if (Object.keys(query).some(key => key !== "month")) {
    throw Object.assign(new Error("Invalid registration query."), { status: 400 });
  }
  const month = parseMonth(query.month);
  // Boundaries and grouping both use Bangkok, irrespective of the DB timezone.
  // No names, phone numbers, IDs, device identifiers, or health data leave CRM.
  const { rows } = await db.query(`WITH bounds AS (
    SELECT $1::date AS start_day, ($1::date + interval '1 month')::date AS end_day
  ), counts AS (
    SELECT (r.registered_at AT TIME ZONE 'Asia/Bangkok')::date::text AS date,
           r.branch_code AS "branchCode", count(*)::int AS count
    FROM crm_reporting.member_registrations r, bounds b
    WHERE r.registered_at >= (b.start_day::timestamp AT TIME ZONE 'Asia/Bangkok')
      AND r.registered_at < (b.end_day::timestamp AT TIME ZONE 'Asia/Bangkok')
      AND r.registered_at <= $2::timestamptz
      AND r.registered_at >= (SELECT tracking_started_at FROM crm_reporting.registration_tracking WHERE id = 1)
    GROUP BY 1, 2
  ) SELECT
    (SELECT tracking_started_at FROM crm_reporting.registration_tracking WHERE id = 1) AS "trackingStartedAt",
    COALESCE((SELECT json_agg(c ORDER BY c.date, c."branchCode") FROM counts c), '[]'::json) AS counts`,
  [`${month}-01`, now.toISOString()]);
  if (!rows[0]?.trackingStartedAt) throw new Error("Registration tracking is not configured.");
  return { ok: true, month, timeZone: "Asia/Bangkok", generatedAt: now.toISOString(),
    trackingStartedAt: rows[0].trackingStartedAt, counts: rows[0].counts };
}

module.exports = { BRANCH_CODES, registrationBranch, recordMemberRegistration, parseMonth, registrationCounts };
