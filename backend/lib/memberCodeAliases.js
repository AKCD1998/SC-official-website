"use strict";

// Keep this off until the private alias schema and the API's SELECT grant are
// provisioned. Existing preview deployments need no additional database objects.
function enabled() {
  return process.env.SC_OFFICIAL_MEMBER_CODE_ALIASES_ENABLED === "true";
}

function normalizeMemberCode(value) {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9-]{1,50}$/.test(code) ? code : null;
}

// Aliases identify accounts only. They never infer identity from a name/phone,
// modify a profile, or become an alternative owner for an existing code.
async function findMemberIdByCode(db, rawCode) {
  if (!enabled()) return null;
  const code = normalizeMemberCode(rawCode);
  if (!code) return null;

  let rows;
  try {
    ({ rows } = await db.query(`WITH candidates AS (
      SELECT m.user_id AS member_id FROM public.member_profiles m
      WHERE m.member_code = $1
      UNION
      SELECT a.member_id FROM sccrm_member_codes.aliases a
      JOIN public.member_profiles m ON m.user_id = a.member_id
      WHERE a.code = $1
    ) SELECT c.member_id FROM candidates c
      JOIN public.users u ON u.id = c.member_id LIMIT 2`, [code]));
  } catch {
    throw Object.assign(new Error("Member code lookup is temporarily unavailable."), {
      status: 503, code: "MEMBER_CODE_ALIASES_UNAVAILABLE",
    });
  }
  // Detect an alias/current-code collision in one database snapshot instead of
  // silently picking either account. The publisher must resolve it explicitly.
  if (rows.length > 1) {
    throw Object.assign(new Error("Member code requires administrator review."), {
      status: 409, code: "MEMBER_CODE_AMBIGUOUS",
    });
  }
  return rows[0]?.member_id || null;
}

module.exports = { enabled, normalizeMemberCode, findMemberIdByCode };
