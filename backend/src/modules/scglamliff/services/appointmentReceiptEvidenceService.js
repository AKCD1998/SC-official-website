function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

const APPOINTMENT_RECEIPTS_TABLE = 'appointment_receipts';
const APPOINTMENT_RECEIPTS_SCHEMA_STATEMENTS = Object.freeze([
  `
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";
  `,
  `
    CREATE TABLE IF NOT EXISTS public.appointment_receipts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      appointment_id uuid NOT NULL UNIQUE REFERENCES public.appointments(id) ON DELETE CASCADE,
      receipt_image_ref text,
      receipt_number text,
      receipt_line text,
      receipt_identifier text,
      total_amount_thb numeric(12, 2),
      ocr_status text,
      ocr_raw_text text,
      ocr_metadata jsonb,
      verification_source text,
      verification_metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT appointment_receipts_total_amount_thb_check
        CHECK (total_amount_thb IS NULL OR total_amount_thb >= 0),
      CONSTRAINT appointment_receipts_ocr_metadata_object_check
        CHECK (ocr_metadata IS NULL OR jsonb_typeof(ocr_metadata) = 'object'),
      CONSTRAINT appointment_receipts_verification_metadata_object_check
        CHECK (
          verification_metadata IS NULL
          OR jsonb_typeof(verification_metadata) = 'object'
        )
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS appointment_receipts_created_at_idx
    ON public.appointment_receipts (created_at DESC);
  `,
  `
    CREATE INDEX IF NOT EXISTS appointment_receipts_verification_source_idx
    ON public.appointment_receipts (verification_source);
  `,
]);

let ensureAppointmentReceiptsSchemaPromise = null;

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalObject(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  if (!isPlainObject(value)) {
    throw badRequest(`${fieldName} must be an object`);
  }

  return Object.keys(value).length > 0 ? value : null;
}

function parseOptionalMoney(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;

  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw badRequest(`${fieldName} must be a non-negative number`);
  }

  return Math.round(parsed * 100) / 100;
}

function toNullableText(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

async function ensureAppointmentReceiptsSchema({
  queryFn,
  logger = console,
} = {}) {
  for (const statement of APPOINTMENT_RECEIPTS_SCHEMA_STATEMENTS) {
    await queryFn(statement);
  }

  logger?.info?.(
    '[AppointmentReceiptEvidence]',
    JSON.stringify({
      event: 'appointment_receipts_schema_ensured',
      table: APPOINTMENT_RECEIPTS_TABLE,
      statementsApplied: APPOINTMENT_RECEIPTS_SCHEMA_STATEMENTS.length,
    })
  );
}

async function ensureAppointmentReceiptsSchemaOnce({
  queryFn,
  logger = console,
} = {}) {
  if (!ensureAppointmentReceiptsSchemaPromise) {
    ensureAppointmentReceiptsSchemaPromise = ensureAppointmentReceiptsSchema({
      queryFn,
      logger,
    }).catch((error) => {
      ensureAppointmentReceiptsSchemaPromise = null;
      throw error;
    });
  }

  return ensureAppointmentReceiptsSchemaPromise;
}

export function resetAppointmentReceiptsSchemaEnsureCacheForTests() {
  ensureAppointmentReceiptsSchemaPromise = null;
}

function mapReceiptRow(row) {
  if (!row) return null;
  return {
    id: normalizeText(row.id),
    appointment_id: normalizeText(row.appointment_id),
    receipt_image_ref: toNullableText(row.receipt_image_ref),
    receipt_number: toNullableText(row.receipt_number),
    receipt_line: toNullableText(row.receipt_line),
    receipt_identifier: toNullableText(row.receipt_identifier),
    total_amount_thb:
      row.total_amount_thb === null || row.total_amount_thb === undefined
        ? null
        : Number(row.total_amount_thb),
    ocr_status: toNullableText(row.ocr_status),
    ocr_raw_text: toNullableText(row.ocr_raw_text),
    ocr_metadata: row.ocr_metadata ?? null,
    verification_source: toNullableText(row.verification_source),
    verification_metadata: row.verification_metadata ?? null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

export function parseOptionalReceiptEvidence(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  if (!isPlainObject(rawValue)) {
    throw badRequest('receipt_evidence must be an object');
  }

  const parsed = {
    receipt_image_ref: toNullableText(rawValue.receipt_image_ref),
    receipt_number: toNullableText(rawValue.receipt_number),
    receipt_line: toNullableText(rawValue.receipt_line),
    receipt_identifier: toNullableText(rawValue.receipt_identifier),
    total_amount_thb: parseOptionalMoney(
      rawValue.total_amount_thb,
      'receipt_evidence.total_amount_thb'
    ),
    ocr_status: toNullableText(rawValue.ocr_status),
    ocr_raw_text: toNullableText(rawValue.ocr_raw_text),
    ocr_metadata: normalizeOptionalObject(rawValue.ocr_metadata, 'receipt_evidence.ocr_metadata'),
    verification_source: toNullableText(rawValue.verification_source),
    verification_metadata: normalizeOptionalObject(
      rawValue.verification_metadata,
      'receipt_evidence.verification_metadata'
    ),
  };

  const hasMeaningfulField = Object.values(parsed).some((value) => {
    if (value === null || value === undefined) return false;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  });

  if (!hasMeaningfulField) {
    throw badRequest('receipt_evidence must include at least one supported field');
  }

  return parsed;
}

export function buildReceiptEvidenceSummary(receiptEvidence) {
  if (!receiptEvidence) return null;
  return {
    has_receipt_evidence: true,
    receipt_number: receiptEvidence.receipt_number,
    receipt_line: receiptEvidence.receipt_line,
    receipt_identifier: receiptEvidence.receipt_identifier,
    total_amount_thb: receiptEvidence.total_amount_thb,
    verification_source: receiptEvidence.verification_source,
  };
}

export async function insertAppointmentReceiptEvidence(client, { appointmentId, receiptEvidence }) {
  if (!receiptEvidence) return null;

  try {
    await ensureAppointmentReceiptsSchemaOnce({
      queryFn: client.query.bind(client),
    });

    console.info(
      '[AppointmentReceiptEvidence]',
      JSON.stringify({
        event: 'appointment_receipt_insert_attempt',
        table: APPOINTMENT_RECEIPTS_TABLE,
        appointmentId,
        hasReceiptImageRef: Boolean(receiptEvidence.receipt_image_ref),
        hasReceiptNumber: Boolean(receiptEvidence.receipt_number),
        hasReceiptLine: Boolean(receiptEvidence.receipt_line),
        hasReceiptIdentifier: Boolean(receiptEvidence.receipt_identifier),
        hasTotalAmount: receiptEvidence.total_amount_thb !== null,
        hasOcrMetadata: Boolean(receiptEvidence.ocr_metadata),
        verificationSource: receiptEvidence.verification_source || null,
        verificationMetadataKeys:
          receiptEvidence.verification_metadata &&
          typeof receiptEvidence.verification_metadata === 'object'
            ? Object.keys(receiptEvidence.verification_metadata).sort()
            : [],
      })
    );

    const result = await client.query(
      `
        INSERT INTO appointment_receipts (
          appointment_id,
          receipt_image_ref,
          receipt_number,
          receipt_line,
          receipt_identifier,
          total_amount_thb,
          ocr_status,
          ocr_raw_text,
          ocr_metadata,
          verification_source,
          verification_metadata
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
          $9::jsonb,
          $10,
          $11::jsonb
        )
        RETURNING
          id,
          appointment_id,
          receipt_image_ref,
          receipt_number,
          receipt_line,
          receipt_identifier,
          total_amount_thb,
          ocr_status,
          ocr_raw_text,
          ocr_metadata,
          verification_source,
          verification_metadata,
          created_at,
          updated_at
      `,
      [
        appointmentId,
        receiptEvidence.receipt_image_ref,
        receiptEvidence.receipt_number,
        receiptEvidence.receipt_line,
        receiptEvidence.receipt_identifier,
        receiptEvidence.total_amount_thb,
        receiptEvidence.ocr_status,
        receiptEvidence.ocr_raw_text,
        receiptEvidence.ocr_metadata ? JSON.stringify(receiptEvidence.ocr_metadata) : null,
        receiptEvidence.verification_source,
        receiptEvidence.verification_metadata
          ? JSON.stringify(receiptEvidence.verification_metadata)
          : null,
      ]
    );

    return mapReceiptRow(result.rows[0] || null);
  } catch (error) {
    console.error(
      '[AppointmentReceiptEvidence]',
      JSON.stringify({
        event: 'appointment_receipt_insert_failed',
        table: APPOINTMENT_RECEIPTS_TABLE,
        appointmentId,
        message: error?.message || 'Failed to persist appointment receipt evidence',
        code: error?.code || null,
        detail: error?.detail || null,
        constraint: error?.constraint || null,
        tableName: error?.table || null,
        column: error?.column || null,
        where: error?.where || null,
      })
    );
    throw error;
  }
}

export async function getAppointmentReceiptEvidenceByAppointmentId(client, appointmentId) {
  await ensureAppointmentReceiptsSchemaOnce({
    queryFn: client.query.bind(client),
  });

  const result = await client.query(
    `
      SELECT
        id,
        appointment_id,
        receipt_image_ref,
        receipt_number,
        receipt_line,
        receipt_identifier,
        total_amount_thb,
        ocr_status,
        ocr_raw_text,
        ocr_metadata,
        verification_source,
        verification_metadata,
        created_at,
        updated_at
      FROM appointment_receipts
      WHERE appointment_id = $1
      LIMIT 1
    `,
    [appointmentId]
  );

  return mapReceiptRow(result.rows[0] || null);
}
