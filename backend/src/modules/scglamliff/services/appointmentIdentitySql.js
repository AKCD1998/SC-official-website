const APPOINTMENT_IDENTITY_JOINS_SQL = `
  LEFT JOIN LATERAL (
    SELECT provider_user_id
    FROM customer_identities
    WHERE customer_id = c.id
      AND provider = 'PHONE'
      AND is_active = true
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  ) ci_phone ON true
  LEFT JOIN LATERAL (
    SELECT provider_user_id
    FROM customer_identities
    WHERE customer_id = c.id
      AND provider = 'LINE'
      AND is_active = true
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  ) ci_line ON true
  LEFT JOIN LATERAL (
    SELECT provider_user_id
    FROM customer_identities
    WHERE customer_id = c.id
      AND provider = 'EMAIL'
      AND is_active = true
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  ) ci_email ON true
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(
        NULLIF(ae.meta->'after'->>'staff_name', ''),
        NULLIF(ae.meta->>'staff_name', '')
      ) AS staff_name
    FROM appointment_events ae
    WHERE ae.appointment_id = a.id
      AND (
        COALESCE(ae.meta->'after', '{}'::jsonb) ? 'staff_name'
        OR ae.meta ? 'staff_name'
      )
      AND COALESCE(
        NULLIF(ae.meta->'after'->>'staff_name', ''),
        NULLIF(ae.meta->>'staff_name', '')
      ) IS NOT NULL
    ORDER BY ae.event_at DESC NULLS LAST, ae.id DESC
    LIMIT 1
  ) staff_name_evt ON true
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(
        NULLIF(ae.meta->'after'->>'staff_display_name', ''),
        NULLIF(ae.meta->>'staff_display_name', '')
      ) AS staff_display_name
    FROM appointment_events ae
    WHERE ae.appointment_id = a.id
      AND (
        COALESCE(ae.meta->'after', '{}'::jsonb) ? 'staff_display_name'
        OR ae.meta ? 'staff_display_name'
      )
      AND COALESCE(
        NULLIF(ae.meta->'after'->>'staff_display_name', ''),
        NULLIF(ae.meta->>'staff_display_name', '')
      ) IS NOT NULL
    ORDER BY ae.event_at DESC NULLS LAST, ae.id DESC
    LIMIT 1
  ) staff_display_evt ON true
`;

const RESOLVED_PHONE_SQL = `
  COALESCE(NULLIF(ci_phone.provider_user_id, ''), '')
`;

const RESOLVED_EMAIL_OR_LINEID_SQL = `
  COALESCE(
    NULLIF(ci_line.provider_user_id, ''),
    NULLIF(ci_email.provider_user_id, ''),
    ''
  )
`;

const RESOLVED_STAFF_NAME_SQL = `
  COALESCE(
    NULLIF(staff_name_evt.staff_name, ''),
    NULLIF(staff_display_evt.staff_display_name, ''),
    ''
  )
`;

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function pickFirstText(row, fields) {
  for (const field of fields) {
    const value = normalizeText(row?.[field]);
    if (value) return value;
  }
  return '';
}

function collectMissingSsotStaff(rows, { idFields, staffFields, maxIds }) {
  const missingIds = [];
  let missingCount = 0;

  for (const row of rows || []) {
    const staffName = pickFirstText(row, staffFields);
    if (staffName) continue;
    missingCount += 1;
    if (missingIds.length >= maxIds) continue;
    const id = pickFirstText(row, idFields) || '(unknown)';
    missingIds.push(id);
  }

  return { missingCount, missingIds };
}

function buildSsotStaffError({ endpointLabel, missingCount, missingIds }) {
  const err = new Error(
    `Missing SSOT staff_name in ${endpointLabel} for ${missingCount} appointment(s)`
  );
  err.status = 500;
  err.code = 'SSOT_STAFF_MISSING';
  err.details = {
    endpoint: endpointLabel,
    missing_count: missingCount,
    appointment_ids: missingIds,
  };
  return err;
}

function assertSsotStaffRows(rows, { endpointLabel, idFields, staffFields, logger = console }) {
  const { missingCount, missingIds } = collectMissingSsotStaff(rows, {
    idFields,
    staffFields,
    maxIds: 25,
  });
  if (missingCount <= 0) return;
  logger.error(`[ssot] missing staff_name endpoint=${endpointLabel} ids=${missingIds.join(', ')}`);
  throw buildSsotStaffError({ endpointLabel, missingCount, missingIds });
}

function assertSsotStaffRow(row, { endpointLabel, idFields, staffFields, logger = console }) {
  assertSsotStaffRows([row], { endpointLabel, idFields, staffFields, logger });
}

export {
  APPOINTMENT_IDENTITY_JOINS_SQL,
  RESOLVED_PHONE_SQL,
  RESOLVED_EMAIL_OR_LINEID_SQL,
  RESOLVED_STAFF_NAME_SQL,
  assertSsotStaffRows,
  assertSsotStaffRow,
  normalizeText,
};
