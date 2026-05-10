import { createCanonicalAppointmentFromBody } from './appointmentCreateService.js';
import { parseOptionalReceiptEvidence } from './appointmentReceiptEvidenceService.js';
import { normalizeBranchWriteValue } from '../utils/branchContract.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPOINTMENT_DRAFTS_TABLE = 'appointment_drafts';
const ALL_DRAFT_STATUSES = ['draft', 'submitted', 'cancelled'];
const DEFAULT_LIST_STATUSES = ['draft', 'submitted'];
const ALLOWED_CREATE_PATCH_STATUSES = new Set(['draft', 'cancelled']);
const IMMUTABLE_DRAFT_FIELDS = new Set([
  'id',
  'submitted_appointment_id',
  'submitted_at',
  'created_at',
  'updated_at',
  'created_by_staff_user_id',
  'updated_by_staff_user_id',
]);
const APPOINTMENT_DRAFTS_SCHEMA_STATEMENTS = Object.freeze([
  `
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";
  `,
  `
    CREATE TABLE IF NOT EXISTS public.appointment_drafts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      status text NOT NULL DEFAULT 'draft',
      customer_full_name text,
      phone text,
      branch_id text,
      treatment_id uuid REFERENCES public.treatments(id),
      treatment_item_text text,
      package_id uuid REFERENCES public.packages(id),
      staff_name text,
      scheduled_at timestamptz,
      receipt_evidence jsonb,
      source text NOT NULL DEFAULT 'promo_receipt_draft',
      flow_metadata jsonb,
      created_by_staff_user_id uuid REFERENCES public.staff_users(id) ON DELETE SET NULL,
      updated_by_staff_user_id uuid REFERENCES public.staff_users(id) ON DELETE SET NULL,
      submitted_appointment_id uuid REFERENCES public.appointments(id),
      submitted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT appointment_drafts_status_check
        CHECK (LOWER(status) = ANY (ARRAY['draft'::text, 'submitted'::text, 'cancelled'::text])),
      CONSTRAINT appointment_drafts_receipt_evidence_object_check
        CHECK (receipt_evidence IS NULL OR jsonb_typeof(receipt_evidence) = 'object'),
      CONSTRAINT appointment_drafts_flow_metadata_object_check
        CHECK (flow_metadata IS NULL OR jsonb_typeof(flow_metadata) = 'object'),
      CONSTRAINT appointment_drafts_submission_state_check
        CHECK (
          (
            LOWER(status) = 'submitted'
            AND submitted_appointment_id IS NOT NULL
            AND submitted_at IS NOT NULL
          )
          OR (
            LOWER(status) <> 'submitted'
            AND submitted_appointment_id IS NULL
            AND submitted_at IS NULL
          )
        )
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS appointment_drafts_status_created_at_idx
    ON public.appointment_drafts (status, created_at DESC);
  `,
  `
    CREATE INDEX IF NOT EXISTS appointment_drafts_phone_idx
    ON public.appointment_drafts (phone);
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS appointment_drafts_submitted_appointment_id_uidx
    ON public.appointment_drafts (submitted_appointment_id)
    WHERE submitted_appointment_id IS NOT NULL;
  `,
]);

let ensureAppointmentDraftsSchemaPromise = null;

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function hasOwnField(objectValue, fieldName) {
  return Object.prototype.hasOwnProperty.call(objectValue || {}, fieldName);
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function normalizePhone(raw) {
  const digits = normalizeText(raw).replace(/[^\d]/g, '');
  return digits || null;
}

function parseNullablePhone(value) {
  if (value === undefined || value === null || value === '') return null;
  const digits = normalizePhone(value);
  if (!digits || digits.length < 9) {
    throw badRequest('phone must contain at least 9 digits');
  }
  return digits;
}

function requireUuidLike(value, fieldName) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (!UUID_PATTERN.test(normalized)) {
    throw badRequest(`Invalid ${fieldName}`);
  }
  return normalized;
}

function hasTimezoneOffset(value) {
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(value);
}

function parseNullableScheduledAt(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (!hasTimezoneOffset(normalized)) {
    throw badRequest('scheduled_at must include timezone offset (e.g. 2026-02-05T14:00:00+07:00)');
  }
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw badRequest('scheduled_at must be a valid ISO datetime');
  }
  return normalized;
}

function normalizeNullableText(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

async function ensureAppointmentDraftsSchema({
  queryFn,
  logger = console,
} = {}) {
  for (const statement of APPOINTMENT_DRAFTS_SCHEMA_STATEMENTS) {
    await queryFn(statement);
  }

  logger?.info?.(
    '[AppointmentDrafts]',
    JSON.stringify({
      event: 'appointment_drafts_schema_ensured',
      table: APPOINTMENT_DRAFTS_TABLE,
      statementsApplied: APPOINTMENT_DRAFTS_SCHEMA_STATEMENTS.length,
    })
  );
}

async function ensureAppointmentDraftsSchemaOnce({
  queryFn,
  logger = console,
} = {}) {
  if (!ensureAppointmentDraftsSchemaPromise) {
    ensureAppointmentDraftsSchemaPromise = ensureAppointmentDraftsSchema({
      queryFn,
      logger,
    }).catch((error) => {
      ensureAppointmentDraftsSchemaPromise = null;
      throw error;
    });
  }

  return ensureAppointmentDraftsSchemaPromise;
}

export function resetAppointmentDraftsSchemaEnsureCacheForTests() {
  ensureAppointmentDraftsSchemaPromise = null;
}

function toOutputDatetime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseNullableObject(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  if (!isPlainObject(value)) {
    throw badRequest(`${fieldName} must be an object`);
  }
  return Object.keys(value).length > 0 ? value : null;
}

function normalizeDraftStatus(value, { allowSubmitted = false } = {}) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return null;
  if (normalized === 'submitted' && !allowSubmitted) {
    throw badRequest('status cannot be set to submitted manually');
  }
  const allowed = allowSubmitted
    ? new Set([...ALLOWED_CREATE_PATCH_STATUSES, 'submitted'])
    : ALLOWED_CREATE_PATCH_STATUSES;
  if (!allowed.has(normalized)) {
    throw badRequest(
      `status must be one of ${Array.from(allowed).join('|')}`
    );
  }
  return normalized;
}

function parseDraftListStatusFilter(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return {
      statuses: [...DEFAULT_LIST_STATUSES],
    };
  }
  if (normalized === 'all') {
    return {
      statuses: [...ALL_DRAFT_STATUSES],
    };
  }
  if (!ALL_DRAFT_STATUSES.includes(normalized)) {
    throw badRequest('status must be one of draft|submitted|cancelled|all');
  }
  return {
    statuses: [normalized],
  };
}

function mapDraftRow(row) {
  if (!row) return null;
  return {
    id: normalizeText(row.id),
    status: normalizeText(row.status) || 'draft',
    customer_full_name: normalizeNullableText(row.customer_full_name),
    phone: normalizeNullableText(row.phone),
    branch_id: normalizeNullableText(row.branch_id),
    treatment_id: normalizeNullableText(row.treatment_id),
    treatment_item_text: normalizeNullableText(row.treatment_item_text),
    package_id: normalizeNullableText(row.package_id),
    staff_name: normalizeNullableText(row.staff_name),
    scheduled_at: toOutputDatetime(row.scheduled_at),
    receipt_evidence: row.receipt_evidence ?? null,
    source: normalizeNullableText(row.source),
    flow_metadata: row.flow_metadata ?? null,
    created_by_staff_user_id: normalizeNullableText(row.created_by_staff_user_id),
    updated_by_staff_user_id: normalizeNullableText(row.updated_by_staff_user_id),
    submitted_appointment_id: normalizeNullableText(row.submitted_appointment_id),
    submitted_at: toOutputDatetime(row.submitted_at),
    created_at: toOutputDatetime(row.created_at),
    updated_at: toOutputDatetime(row.updated_at),
  };
}

function ensureNoImmutableDraftFields(body = {}) {
  for (const fieldName of IMMUTABLE_DRAFT_FIELDS) {
    if (hasOwnField(body, fieldName)) {
      throw badRequest(`${fieldName} is immutable and cannot be written directly`);
    }
  }
}

function buildDraftCreateValues(body = {}) {
  ensureNoImmutableDraftFields(body);

  return {
    status: normalizeDraftStatus(body.status) || 'draft',
    customer_full_name: normalizeNullableText(body.customer_full_name),
    phone: parseNullablePhone(body.phone),
    branch_id: normalizeBranchWriteValue(body.branch_id),
    treatment_id: requireUuidLike(body.treatment_id, 'treatment_id'),
    treatment_item_text: normalizeNullableText(body.treatment_item_text),
    package_id: requireUuidLike(body.package_id, 'package_id'),
    staff_name: normalizeNullableText(body.staff_name),
    scheduled_at: parseNullableScheduledAt(body.scheduled_at),
    receipt_evidence: parseOptionalReceiptEvidence(body.receipt_evidence),
    source: normalizeNullableText(body.source) || 'promo_receipt_draft',
    flow_metadata: parseNullableObject(body.flow_metadata, 'flow_metadata'),
  };
}

function buildDraftPatchChanges(body = {}) {
  ensureNoImmutableDraftFields(body);

  const changes = {};
  if (hasOwnField(body, 'status')) {
    changes.status = normalizeDraftStatus(body.status) || 'draft';
  }
  if (hasOwnField(body, 'customer_full_name')) {
    changes.customer_full_name = normalizeNullableText(body.customer_full_name);
  }
  if (hasOwnField(body, 'phone')) {
    changes.phone = parseNullablePhone(body.phone);
  }
  if (hasOwnField(body, 'branch_id')) {
    changes.branch_id = normalizeBranchWriteValue(body.branch_id);
  }
  if (hasOwnField(body, 'treatment_id')) {
    changes.treatment_id = requireUuidLike(body.treatment_id, 'treatment_id');
  }
  if (hasOwnField(body, 'treatment_item_text')) {
    changes.treatment_item_text = normalizeNullableText(body.treatment_item_text);
  }
  if (hasOwnField(body, 'package_id')) {
    changes.package_id = requireUuidLike(body.package_id, 'package_id');
  }
  if (hasOwnField(body, 'staff_name')) {
    changes.staff_name = normalizeNullableText(body.staff_name);
  }
  if (hasOwnField(body, 'scheduled_at')) {
    changes.scheduled_at = parseNullableScheduledAt(body.scheduled_at);
  }
  if (hasOwnField(body, 'receipt_evidence')) {
    changes.receipt_evidence = parseOptionalReceiptEvidence(body.receipt_evidence);
  }
  if (hasOwnField(body, 'source')) {
    changes.source = normalizeNullableText(body.source) || 'promo_receipt_draft';
  }
  if (hasOwnField(body, 'flow_metadata')) {
    changes.flow_metadata = parseNullableObject(body.flow_metadata, 'flow_metadata');
  }
  return changes;
}

async function fetchDraftById(client, draftId, { forUpdate = false } = {}) {
  const id = normalizeText(draftId);
  if (!UUID_PATTERN.test(id)) {
    throw badRequest('Invalid draft id');
  }

  const result = await client.query(
    `
      SELECT *
      FROM appointment_drafts
      WHERE id = $1
      LIMIT 1
      ${forUpdate ? 'FOR UPDATE' : ''}
    `,
    [id]
  );

  return result.rows[0] || null;
}

function requireSubmitFields(draft) {
  const requiredFields = [
    'customer_full_name',
    'phone',
    'treatment_id',
    'branch_id',
    'scheduled_at',
    'staff_name',
  ];

  const missing = requiredFields.filter((fieldName) => {
    const value = draft?.[fieldName];
    return value === null || value === undefined || normalizeText(value) === '';
  });

  if (missing.length > 0) {
    const err = new Error(`Draft is missing required submit fields: ${missing.join(', ')}`);
    err.status = 422;
    err.details = { missing_fields: missing };
    throw err;
  }
}

async function resolveDbPool(dbPool) {
  if (dbPool) return dbPool;
  const dbModule = await import('../db.js');
  return dbModule.pool;
}

export async function createAppointmentDraft({ body = {}, user, dbPool = null } = {}) {
  const values = buildDraftCreateValues(body);
  const resolvedDbPool = await resolveDbPool(dbPool);
  const client = await resolvedDbPool.connect();

  try {
    await ensureAppointmentDraftsSchemaOnce({
      queryFn: client.query.bind(client),
    });

    const result = await client.query(
      `
        INSERT INTO appointment_drafts (
          status,
          customer_full_name,
          phone,
          branch_id,
          treatment_id,
          treatment_item_text,
          package_id,
          staff_name,
          scheduled_at,
          receipt_evidence,
          source,
          flow_metadata,
          created_by_staff_user_id,
          updated_by_staff_user_id
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10::jsonb,
          $11,
          $12::jsonb,
          $13,
          $13
        )
        RETURNING *
      `,
      [
        values.status,
        values.customer_full_name,
        values.phone,
        values.branch_id,
        values.treatment_id,
        values.treatment_item_text,
        values.package_id,
        values.staff_name,
        values.scheduled_at,
        values.receipt_evidence ? JSON.stringify(values.receipt_evidence) : null,
        values.source,
        values.flow_metadata ? JSON.stringify(values.flow_metadata) : null,
        normalizeNullableText(user?.id),
      ]
    );

    return mapDraftRow(result.rows[0] || null);
  } finally {
    client.release();
  }
}

export async function getAppointmentDraftById({ draftId, dbPool = null } = {}) {
  const resolvedDbPool = await resolveDbPool(dbPool);
  const client = await resolvedDbPool.connect();
  try {
    await ensureAppointmentDraftsSchemaOnce({
      queryFn: client.query.bind(client),
    });

    const row = await fetchDraftById(client, draftId);
    if (!row) {
      const err = new Error('Appointment draft not found');
      err.status = 404;
      throw err;
    }
    return mapDraftRow(row);
  } finally {
    client.release();
  }
}

export async function listAppointmentDrafts({ status, dbPool = null } = {}) {
  const statusFilter = parseDraftListStatusFilter(status);
  const resolvedDbPool = await resolveDbPool(dbPool);
  const client = await resolvedDbPool.connect();

  try {
    await ensureAppointmentDraftsSchemaOnce({
      queryFn: client.query.bind(client),
    });

    const result = await client.query(
      `
        SELECT *
        FROM appointment_drafts
        WHERE status = ANY($1::text[])
        ORDER BY updated_at DESC, created_at DESC, id DESC
      `,
      [statusFilter.statuses]
    );

    return {
      drafts: (result.rows || []).map((row) => mapDraftRow(row)),
      meta: {
        applied_status_filter: statusFilter.statuses,
        sort: 'updated_at_desc',
      },
    };
  } finally {
    client.release();
  }
}

export async function patchAppointmentDraft({ draftId, body = {}, user, dbPool = null } = {}) {
  const changes = buildDraftPatchChanges(body);
  const resolvedDbPool = await resolveDbPool(dbPool);
  const client = await resolvedDbPool.connect();

  try {
    await ensureAppointmentDraftsSchemaOnce({
      queryFn: client.query.bind(client),
    });

    await client.query('BEGIN');

    const current = await fetchDraftById(client, draftId, { forUpdate: true });
    if (!current) {
      const err = new Error('Appointment draft not found');
      err.status = 404;
      throw err;
    }

    const currentStatus = normalizeText(current.status).toLowerCase();
    if (currentStatus === 'submitted') {
      const err = new Error('Submitted drafts cannot be edited');
      err.status = 409;
      throw err;
    }

    const setParts = [];
    const params = [];

    for (const [fieldName, fieldValue] of Object.entries(changes)) {
      params.push(fieldValue);
      const placeholder = fieldValue && typeof fieldValue === 'object'
        ? `$${params.length}::jsonb`
        : `$${params.length}`;
      setParts.push(`${fieldName} = ${placeholder}`);
      if (fieldValue && typeof fieldValue === 'object') {
        params[params.length - 1] = JSON.stringify(fieldValue);
      }
    }

    if (setParts.length === 0) {
      const err = new Error('No changes detected');
      err.status = 400;
      throw err;
    }

    params.push(normalizeNullableText(user?.id));
    setParts.push(`updated_by_staff_user_id = $${params.length}`);
    setParts.push('updated_at = now()');

    params.push(normalizeText(draftId));
    const result = await client.query(
      `
        UPDATE appointment_drafts
        SET ${setParts.join(', ')}
        WHERE id = $${params.length}
        RETURNING *
      `,
      params
    );

    await client.query('COMMIT');
    return mapDraftRow(result.rows[0] || null);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function submitAppointmentDraft({
  draftId,
  user,
  dbPool = null,
  createAppointmentFn = createCanonicalAppointmentFromBody,
} = {}) {
  const resolvedDbPool = await resolveDbPool(dbPool);
  const client = await resolvedDbPool.connect();

  try {
    await ensureAppointmentDraftsSchemaOnce({
      queryFn: client.query.bind(client),
    });

    await client.query('BEGIN');

    const draft = await fetchDraftById(client, draftId, { forUpdate: true });
    if (!draft) {
      const err = new Error('Appointment draft not found');
      err.status = 404;
      throw err;
    }

    const currentStatus = normalizeText(draft.status).toLowerCase();
    if (currentStatus === 'submitted') {
      const err = new Error('Appointment draft has already been submitted');
      err.status = 409;
      err.details = {
        submitted_appointment_id: normalizeNullableText(draft.submitted_appointment_id),
      };
      throw err;
    }
    if (currentStatus === 'cancelled') {
      const err = new Error('Cancelled drafts cannot be submitted');
      err.status = 409;
      throw err;
    }

    const mappedDraft = mapDraftRow(draft);
    requireSubmitFields(mappedDraft);

    const appointmentResult = await createAppointmentFn({
      client,
      body: {
        scheduled_at: mappedDraft.scheduled_at,
        branch_id: mappedDraft.branch_id,
        customer_full_name: mappedDraft.customer_full_name,
        phone: mappedDraft.phone,
        staff_name: mappedDraft.staff_name,
        treatment_id: mappedDraft.treatment_id,
        treatment_item_text: mappedDraft.treatment_item_text,
        package_id: mappedDraft.package_id,
        receipt_evidence: mappedDraft.receipt_evidence,
      },
      user,
      eventMetaExtra: {
        source: 'appointment_draft_submit',
        draft_id: mappedDraft.id,
        draft_source: mappedDraft.source || null,
      },
    });

    const updateResult = await client.query(
      `
        UPDATE appointment_drafts
        SET status = 'submitted',
            submitted_appointment_id = $2,
            submitted_at = now(),
            updated_by_staff_user_id = $3,
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [mappedDraft.id, appointmentResult.appointment_id, normalizeNullableText(user?.id)]
    );

    await client.query('COMMIT');
    return {
      draft: mapDraftRow(updateResult.rows[0] || null),
      appointment: appointmentResult,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function buildAppointmentDraftErrorResponse(
  error,
  {
    isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production',
  } = {}
) {
  if (error?.status) {
    const body = {
      ok: false,
      error: error.message,
    };
    if (error?.code) {
      body.code = error.code;
    }
    if (error?.details) {
      body.details = error.details;
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
      error: isProd ? 'Server error' : error?.message || 'Server error',
      code: isProd ? undefined : error?.code || null,
    },
  };
}
