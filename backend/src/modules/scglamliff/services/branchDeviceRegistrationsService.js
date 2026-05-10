import { extractLineCredentialPayload, verifyLineLiffIdentity } from './lineLiffIdentityService.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALL_STATUSES = ['active', 'inactive'];

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeNullableText(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

function maskLineUserId(lineUserId) {
  const normalized = normalizeText(lineUserId);
  if (!normalized) return null;
  if (normalized.length <= 8) {
    return `${normalized.slice(0, 2)}***${normalized.slice(-2)}`;
  }
  return `${normalized.slice(0, 4)}***${normalized.slice(-4)}`;
}

function updateTrace(trace, patch = {}) {
  if (!trace || typeof trace !== 'object') {
    return;
  }

  Object.assign(trace, patch);
}

function toOutputDatetime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function hasOwnField(objectValue, fieldName) {
  return Object.prototype.hasOwnProperty.call(objectValue || {}, fieldName);
}

function badRequest(message, details = null, reason = 'bad_request') {
  const err = new Error(message);
  err.status = 400;
  err.reason = reason;
  if (details) {
    err.details = details;
  }
  return err;
}

function classifyBranchDeviceLookupFailure(error) {
  const normalizedCode = normalizeText(error?.code).toUpperCase();

  if (normalizedCode === '42P01') return 'missing_relation';
  if (normalizedCode === '42703') return 'missing_column';
  if (normalizedCode === '42883') return 'schema_mismatch';
  if (normalizedCode) return 'query_failed';
  return 'server_error';
}

function parseStatus(value, { allowEmpty = false } = {}) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    if (allowEmpty) return null;
    throw badRequest(`status must be one of ${ALL_STATUSES.join('|')}`);
  }
  if (!ALL_STATUSES.includes(normalized)) {
    throw badRequest(`status must be one of ${ALL_STATUSES.join('|')}`);
  }
  return normalized;
}

function parseListStatusFilter(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized || normalized === 'all') {
    return {
      statuses: [...ALL_STATUSES],
      label: normalized === 'all' ? 'all' : 'default',
    };
  }
  if (!ALL_STATUSES.includes(normalized)) {
    throw badRequest('status must be one of active|inactive|all');
  }
  return {
    statuses: [normalized],
    label: normalized,
  };
}

function mapBranchDeviceRegistrationRow(row) {
  if (!row) return null;
  return {
    id: normalizeText(row.id),
    line_user_id: normalizeText(row.line_user_id),
    branch_id: normalizeText(row.branch_id),
    device_label: normalizeNullableText(row.device_label),
    liff_app_id: normalizeNullableText(row.liff_app_id),
    status: normalizeText(row.status).toLowerCase() || 'active',
    linked_at: toOutputDatetime(row.linked_at),
    last_seen_at: toOutputDatetime(row.last_seen_at),
    notes: normalizeNullableText(row.notes),
    registered_by_staff_user_id: normalizeNullableText(row.registered_by_staff_user_id),
    updated_by_staff_user_id: normalizeNullableText(row.updated_by_staff_user_id),
    created_at: toOutputDatetime(row.created_at),
    updated_at: toOutputDatetime(row.updated_at),
  };
}

function buildRegistrationCreateValues({ body = {}, headers = {} } = {}) {
  const branchId = normalizeText(body?.branch_id);
  if (!branchId) {
    throw badRequest('branch_id is required', null, 'missing_branch_id');
  }

  return {
    branch_id: branchId,
    device_label: normalizeNullableText(body?.device_label),
    liff_app_id:
      normalizeNullableText(body?.liff_app_id) ||
      normalizeNullableText(headers?.['x-liff-app-id']),
    notes: normalizeNullableText(body?.notes),
    has_device_label: hasOwnField(body, 'device_label'),
    has_liff_app_id: hasOwnField(body, 'liff_app_id') || Boolean(headers?.['x-liff-app-id']),
    has_notes: hasOwnField(body, 'notes'),
  };
}

function buildRegistrationPatchChanges(body = {}) {
  const changes = {};

  if (hasOwnField(body, 'status')) {
    changes.status = parseStatus(body?.status);
  }
  if (hasOwnField(body, 'device_label')) {
    changes.device_label = normalizeNullableText(body?.device_label);
  }
  if (hasOwnField(body, 'notes')) {
    changes.notes = normalizeNullableText(body?.notes);
  }

  if (Object.keys(changes).length === 0) {
    throw badRequest('At least one field is required: status, device_label, notes');
  }

  return changes;
}

async function resolveDbPool(dbPool) {
  if (dbPool) return dbPool;
  const dbModule = await import('../db.js');
  return dbModule.pool;
}

async function fetchRegistrationByLineUserId(client, lineUserId, { forUpdate = false } = {}) {
  const normalizedLineUserId = normalizeText(lineUserId);
  if (!normalizedLineUserId) return null;

  const result = await client.query(
    `
      SELECT *
      FROM branch_device_registrations
      WHERE line_user_id = $1
      LIMIT 1
      ${forUpdate ? 'FOR UPDATE' : ''}
    `,
    [normalizedLineUserId]
  );

  return result.rows[0] || null;
}

async function fetchRegistrationById(client, registrationId, { forUpdate = false } = {}) {
  const normalizedId = normalizeText(registrationId);
  if (!UUID_PATTERN.test(normalizedId)) {
    throw badRequest('Invalid registration id');
  }

  const result = await client.query(
    `
      SELECT *
      FROM branch_device_registrations
      WHERE id = $1
      LIMIT 1
      ${forUpdate ? 'FOR UPDATE' : ''}
    `,
    [normalizedId]
  );

  return result.rows[0] || null;
}

export async function createOrUpdateBranchDeviceRegistration({
  body = {},
  headers = {},
  user,
  dbPool = null,
  verifyLineIdentityFn = verifyLineLiffIdentity,
  trace = null,
} = {}) {
  const values = buildRegistrationCreateValues({ body, headers });
  let lineCredentialPayload;
  try {
    lineCredentialPayload = extractLineCredentialPayload({ headers, body });
  } catch (error) {
    updateTrace(trace, {
      liffVerification: 'failure',
      verificationReason: normalizeNullableText(error?.reason || 'missing_token'),
    });
    throw error;
  }

  let lineIdentity;
  try {
    lineIdentity = await verifyLineIdentityFn(lineCredentialPayload);
  } catch (error) {
    updateTrace(trace, {
      liffVerification: 'failure',
      verificationReason: normalizeNullableText(error?.reason || 'invalid_token'),
    });
    throw error;
  }

  const lineUserId = normalizeText(lineIdentity?.line_user_id);

  if (!lineUserId) {
    const err = new Error('Unable to resolve verified LINE user id');
    err.status = 401;
    err.code = 'LINE_IDENTITY_UNAVAILABLE';
    err.reason = 'invalid_token';
    updateTrace(trace, {
      liffVerification: 'failure',
      verificationReason: 'invalid_token',
    });
    throw err;
  }

  updateTrace(trace, {
    liffVerification: 'success',
    verificationReason: null,
    resolvedLineUserId: maskLineUserId(lineUserId),
  });

  const resolvedDbPool = await resolveDbPool(dbPool);
  const client = await resolvedDbPool.connect();

  try {
    await client.query('BEGIN');

    const existing = await fetchRegistrationByLineUserId(client, lineUserId, {
      forUpdate: true,
    });

    updateTrace(trace, {
      lookupResult: existing
        ? normalizeText(existing?.status).toLowerCase() === 'active'
          ? 'registration_found_active'
          : 'registration_found_inactive'
        : 'no_registration',
    });

    let result;
    let action = 'created';

    if (existing) {
      const nextDeviceLabel = values.has_device_label
        ? values.device_label
        : normalizeNullableText(existing.device_label);
      const nextLiffAppId = values.has_liff_app_id
        ? values.liff_app_id
        : normalizeNullableText(existing.liff_app_id);
      const nextNotes = values.has_notes ? values.notes : normalizeNullableText(existing.notes);

      result = await client.query(
        `
          UPDATE branch_device_registrations
          SET branch_id = $2,
              device_label = $3,
              liff_app_id = $4,
              status = 'active',
              linked_at = now(),
              last_seen_at = now(),
              notes = $5,
              updated_by_staff_user_id = $6,
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [
          existing.id,
          values.branch_id,
          nextDeviceLabel,
          nextLiffAppId,
          nextNotes,
          normalizeNullableText(user?.id),
        ]
      );
      action = 'updated';
    } else {
      result = await client.query(
        `
          INSERT INTO branch_device_registrations (
            line_user_id,
            branch_id,
            device_label,
            liff_app_id,
            status,
            linked_at,
            last_seen_at,
            notes,
            registered_by_staff_user_id,
            updated_by_staff_user_id
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            'active',
            now(),
            now(),
            $5,
            $6,
            $6
          )
          RETURNING *
        `,
        [
          lineUserId,
          values.branch_id,
          values.device_label,
          values.liff_app_id,
          values.notes,
          normalizeNullableText(user?.id),
        ]
      );
    }

    await client.query('COMMIT');

    return {
      action,
      created: action === 'created',
      updated: action === 'updated',
      active: true,
      reason: action === 'created' ? 'created' : 'updated',
      registration: mapBranchDeviceRegistrationRow(result.rows[0] || null),
      line_identity: {
        line_user_id: lineUserId,
        display_name: normalizeNullableText(lineIdentity?.display_name),
        picture_url: normalizeNullableText(lineIdentity?.picture_url),
        liff_app_id: normalizeNullableText(lineIdentity?.liff_app_id) || values.liff_app_id,
        verification_source: normalizeText(lineIdentity?.verification_source) || null,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listBranchDeviceRegistrations({
  status,
  branchId,
  lineUserId,
  dbPool = null,
} = {}) {
  const statusFilter = parseListStatusFilter(status);
  const normalizedBranchId = normalizeNullableText(branchId);
  const normalizedLineUserId = normalizeNullableText(lineUserId);
  const resolvedDbPool = await resolveDbPool(dbPool);
  const client = await resolvedDbPool.connect();

  try {
    const params = [];
    const whereParts = [];

    if (statusFilter.statuses.length === 1) {
      params.push(statusFilter.statuses);
      whereParts.push(`LOWER(status) = ANY($${params.length}::text[])`);
    }
    if (normalizedBranchId) {
      params.push(normalizedBranchId);
      whereParts.push(`branch_id = $${params.length}`);
    }
    if (normalizedLineUserId) {
      params.push(normalizedLineUserId);
      whereParts.push(`line_user_id = $${params.length}`);
    }

    const result = await client.query(
      `
        SELECT *
        FROM branch_device_registrations
        ${whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : ''}
        ORDER BY updated_at DESC, created_at DESC, id DESC
      `,
      params
    );

    return {
      rows: (result.rows || []).map((row) => mapBranchDeviceRegistrationRow(row)),
      meta: {
        applied_status_filter: statusFilter.statuses,
        branch_id: normalizedBranchId,
        line_user_id: normalizedLineUserId,
        sort: 'updated_at_desc',
      },
    };
  } finally {
    client.release();
  }
}

export async function getBranchDeviceRegistrationMe({
  headers = {},
  body = {},
  dbPool = null,
  verifyLineIdentityFn = verifyLineLiffIdentity,
  trace = null,
} = {}) {
  let lineCredentialPayload;
  try {
    lineCredentialPayload = extractLineCredentialPayload({ headers, body });
  } catch (error) {
    updateTrace(trace, {
      liffVerification: 'failure',
      verificationReason: normalizeNullableText(error?.reason || 'missing_token'),
    });
    throw error;
  }

  let lineIdentity;
  try {
    lineIdentity = await verifyLineIdentityFn(lineCredentialPayload);
  } catch (error) {
    updateTrace(trace, {
      liffVerification: 'failure',
      verificationReason: normalizeNullableText(error?.reason || 'invalid_token'),
    });
    throw error;
  }

  const lineUserId = normalizeText(lineIdentity?.line_user_id);

  if (!lineUserId) {
    const err = new Error('Unable to resolve verified LINE user id');
    err.status = 401;
    err.code = 'LINE_IDENTITY_UNAVAILABLE';
    err.reason = 'invalid_token';
    updateTrace(trace, {
      liffVerification: 'failure',
      verificationReason: 'invalid_token',
    });
    throw err;
  }

  updateTrace(trace, {
    liffVerification: 'success',
    verificationReason: null,
    resolvedLineUserId: maskLineUserId(lineUserId),
  });

  const resolvedDbPool = await resolveDbPool(dbPool);
  let client = null;

  try {
    client = await resolvedDbPool.connect();
    const existing = await fetchRegistrationByLineUserId(client, lineUserId);
    let registration = existing;

    if (existing) {
      const touchResult = await client.query(
        `
          UPDATE branch_device_registrations
          SET last_seen_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [existing.id]
      );
      registration = touchResult.rows[0] || existing;
    }

    const mapped = mapBranchDeviceRegistrationRow(registration);
    const isActive = normalizeText(mapped?.status).toLowerCase() === 'active';
    const reason = !mapped ? 'not_registered' : isActive ? 'active' : 'inactive';

    updateTrace(trace, {
      lookupResult: !mapped
        ? 'no_registration'
        : isActive
          ? 'registration_found_active'
          : 'registration_found_inactive',
    });

    return {
      registered: Boolean(mapped),
      active: Boolean(mapped) ? isActive : null,
      reason,
      branch_id: mapped?.branch_id || null,
      device_label: mapped?.device_label || null,
      registration: mapped,
      line_identity: {
        line_user_id: lineUserId,
        display_name: normalizeNullableText(lineIdentity?.display_name),
        picture_url: normalizeNullableText(lineIdentity?.picture_url),
        liff_app_id: normalizeNullableText(lineIdentity?.liff_app_id),
        verification_source: normalizeText(lineIdentity?.verification_source) || null,
      },
    };
  } catch (error) {
    updateTrace(trace, {
      failureStage: client ? 'registration_lookup' : 'db_connect',
      lookupFailure: classifyBranchDeviceLookupFailure(error),
    });
    throw error;
  } finally {
    client?.release();
  }
}

export async function patchBranchDeviceRegistration({
  registrationId,
  body = {},
  user,
  dbPool = null,
} = {}) {
  const changes = buildRegistrationPatchChanges(body);
  const resolvedDbPool = await resolveDbPool(dbPool);
  const client = await resolvedDbPool.connect();

  try {
    await client.query('BEGIN');

    const current = await fetchRegistrationById(client, registrationId, { forUpdate: true });
    if (!current) {
      const err = new Error('Branch device registration not found');
      err.status = 404;
      throw err;
    }

    const nextStatus = hasOwnField(changes, 'status')
      ? changes.status
      : normalizeText(current.status).toLowerCase() || 'active';
    const nextDeviceLabel = hasOwnField(changes, 'device_label')
      ? changes.device_label
      : normalizeNullableText(current.device_label);
    const nextNotes = hasOwnField(changes, 'notes')
      ? changes.notes
      : normalizeNullableText(current.notes);

    const result = await client.query(
      `
        UPDATE branch_device_registrations
        SET status = $2,
            device_label = $3,
            notes = $4,
            linked_at = CASE
              WHEN $2 = 'active' AND LOWER(COALESCE(status, '')) <> 'active' THEN now()
              ELSE linked_at
            END,
            updated_by_staff_user_id = $5,
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [
        current.id,
        nextStatus,
        nextDeviceLabel,
        nextNotes,
        normalizeNullableText(user?.id),
      ]
    );

    await client.query('COMMIT');
    return mapBranchDeviceRegistrationRow(result.rows[0] || null);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function buildMeReason(result = {}) {
  const explicitReason = normalizeText(result?.reason).toLowerCase();

  if (explicitReason) {
    return explicitReason;
  }

  if (!result?.registered) {
    return 'not_registered';
  }

  return result?.active ? 'active' : 'inactive';
}

export function buildBranchDeviceRegistrationMeResponse(result = {}) {
  const reason = buildMeReason(result);
  const branchId =
    normalizeNullableText(result?.branch_id) ||
    normalizeNullableText(result?.registration?.branch_id);
  const registrationId = normalizeNullableText(result?.registration?.id);
  const deviceLabel =
    normalizeNullableText(result?.device_label) ||
    normalizeNullableText(result?.registration?.device_label);
  const lineIdentity = result?.line_identity || null;

  return {
    ok: true,
    success: true,
    registered: Boolean(result?.registered),
    active: reason === 'not_registered' ? null : Boolean(result?.active),
    reason,
    branchId,
    registrationId,
    branch_id: branchId,
    device_label: deviceLabel,
    registration: result?.registration || null,
    lineIdentity,
    line_identity: lineIdentity,
  };
}

export function buildBranchDeviceRegistrationMutationResponse(result = {}) {
  const registration = result?.registration || null;
  const branchId = normalizeNullableText(registration?.branch_id);
  const registrationId = normalizeNullableText(registration?.id);
  const created =
    typeof result?.created === 'boolean'
      ? result.created
      : normalizeText(result?.action) === 'created';
  const updated =
    typeof result?.updated === 'boolean'
      ? result.updated
      : normalizeText(result?.action) === 'updated';
  const lineIdentity = result?.line_identity || null;

  return {
    ok: true,
    success: true,
    created,
    updated,
    active: normalizeText(registration?.status).toLowerCase() === 'active',
    reason: normalizeText(result?.reason) || (created ? 'created' : 'updated'),
    branchId,
    registrationId,
    registration,
    lineIdentity,
    line_identity: lineIdentity,
  };
}

function getBranchDeviceErrorReason(error, { endpoint = 'generic' } = {}) {
  const explicitReason = normalizeText(error?.reason);
  if (explicitReason) {
    return explicitReason;
  }

  if (normalizeText(error?.code) === 'LINE_LIFF_CONFIG_MISSING') {
    return 'config_error';
  }

  if (error?.status === 400) {
    return endpoint === 'me' ? 'missing_token' : 'bad_request';
  }

  if (error?.status === 401) {
    return 'invalid_token';
  }

  if (error?.status >= 500) {
    return 'server_error';
  }

  return 'server_error';
}

export function buildBranchDeviceRegistrationErrorResponse(
  error,
  {
    endpoint = 'generic',
    isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production',
  } = {}
) {
  const reason = getBranchDeviceErrorReason(error, { endpoint });
  const shouldExposeMessage =
    Boolean(error?.status && error.status < 500) || reason === 'config_error';
  const message = shouldExposeMessage
    ? error?.message || 'Request failed'
    : isProd
      ? 'Server error'
      : error?.message || 'Server error';

  if (error?.status) {
    const body = {
      ok: false,
      success: false,
      reason,
      error: message,
    };
    if (error?.code) {
      body.code = error.code;
    }
    if (error?.details) {
      body.details = error.details;
    }
    if (endpoint === 'me') {
      body.registered = null;
      body.active = null;
      body.branchId = null;
      body.registrationId = null;
    }
    if (endpoint === 'register') {
      body.created = false;
      body.updated = false;
      body.active = null;
      body.branchId = null;
      body.registrationId = null;
    }
    return {
      status: error.status,
      body,
    };
  }

  return {
    status: 500,
    body: {
      ok: false,
      success: false,
      reason,
      error: isProd ? 'Server error' : error?.message || 'Server error',
      code: isProd ? undefined : error?.code || null,
      ...(endpoint === 'me'
        ? {
            registered: null,
            active: null,
            branchId: null,
            registrationId: null,
          }
        : {}),
      ...(endpoint === 'register'
        ? {
            created: false,
            updated: false,
            active: null,
            branchId: null,
            registrationId: null,
          }
        : {}),
    },
  };
}
