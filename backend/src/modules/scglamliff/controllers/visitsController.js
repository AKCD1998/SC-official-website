import { query } from '../db.js';
import {
  APPOINTMENT_IDENTITY_JOINS_SQL,
  RESOLVED_EMAIL_OR_LINEID_SQL,
  RESOLVED_PHONE_SQL,
  RESOLVED_STAFF_NAME_SQL,
  assertSsotStaffRows,
} from '../services/appointmentIdentitySql.js';

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SOURCES = new Set(['sheet', 'appointments']);
const TIME_PATTERN = /^\d{2}:\d{2}$/;

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function requireField(value, fieldName) {
  const trimmed = normalizeText(value);
  if (!trimmed) {
    const err = new Error(`Missing required field: ${fieldName}`);
    err.status = 400;
    throw err;
  }
  return trimmed;
}

function parseLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function sanitizeDisplayLineId(value) {
  const text = normalizeText(value);
  if (!text) return '';

  if (text === '__STAFF__' || text === '__BACKDATE__') {
    return '';
  }

  const lowered = text.toLowerCase();
  if (lowered.startsWith('phone:') || lowered.startsWith('sheet:')) {
    return '';
  }

  return text;
}

function sanitizeDisplayStaffName(value) {
  const text = normalizeText(value);
  if (!text) return '-';
  return text;
}

export async function listVisits(req, res) {
  const { date } = req.query;
  const sourceRaw = typeof req.query.source === 'string' ? req.query.source.trim() : '';
  const source = SOURCES.has(sourceRaw) ? sourceRaw : 'sheet';
  const limit = parseLimit(req.query.limit);

  if (date && !DATE_PATTERN.test(date)) {
    return res.status(400).json({ ok: false, error: 'Invalid date format. Use YYYY-MM-DD' });
  }

  try {
  const params = [];

  if (source === 'sheet') {
    const whereParts = ['deleted_at IS NULL'];
    if (date) {
      params.push(date);
      whereParts.push(`visit_date = $${params.length}`);
    }
    params.push(limit);

    const whereSql = `WHERE ${whereParts.join(' AND ')}`;
    const limitParam = `$${params.length}`;

    // Legacy sheet linkage can be 1:N if raw_sheet_uuid integrity was broken in older data.
    // Pick one deterministic appointment row (latest updated_at/created_at) to avoid random join winners.
    const { rows } = await query(
      `
        SELECT
          COALESCE(TO_CHAR(visit_date, 'YYYY-MM-DD'), '') AS date,
            COALESCE(visit_time_text, '') AS "bookingTime",
            COALESCE(customer_full_name, '') AS "customerName",
            COALESCE(phone_raw, '') AS phone,
            COALESCE(email_or_lineid, '') AS "lineId",
            COALESCE(treatment_item_text, '') AS "treatmentItem",
            COALESCE(NULLIF(staff_name, ''), '-') AS "staffName",
            sheet_uuid::text AS id,
            COALESCE(a_link.status, 'booked') AS status,
            a_link.id AS appointment_id,
            a_link.customer_id AS customer_id
        FROM public.sheet_visits_raw
        LEFT JOIN LATERAL (
          SELECT a.id, a.customer_id, a.status
          FROM appointments a
          WHERE a.raw_sheet_uuid = sheet_uuid
          ORDER BY a.updated_at DESC NULLS LAST, a.created_at DESC NULLS LAST, a.id DESC
          LIMIT 1
        ) a_link ON true
        ${whereSql}
        ORDER BY visit_date DESC, visit_time_text DESC, imported_at DESC
        LIMIT ${limitParam}
      `,
      params
      );

      const normalizedRows = rows.map((row) => ({
        ...row,
        lineId: sanitizeDisplayLineId(row.lineId),
        staffName: sanitizeDisplayStaffName(row.staffName),
      }));

      return res.json({ ok: true, rows: normalizedRows });
    }

    const whereParts = ["LOWER(COALESCE(a.status, '')) NOT IN ('cancelled', 'canceled')"];

    if (date) {
      params.push(date);
      whereParts.push(`DATE(a.scheduled_at AT TIME ZONE 'Asia/Bangkok') = $${params.length}`);
    }

    params.push(limit);

    // Shape rows for the homepage table by joining appointments with customers and identities.
    const { rows } = await query(
      `
        SELECT
          a.id,
          COALESCE(TO_CHAR(a.scheduled_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD'), '') AS date,
          COALESCE(TO_CHAR(a.scheduled_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI'), '') AS "bookingTime",
          COALESCE(c.full_name, '') AS "customerName",
          ${RESOLVED_PHONE_SQL} AS phone,
          ${RESOLVED_EMAIL_OR_LINEID_SQL} AS "lineId",
          COALESCE(
            NULLIF(t.title_th, ''),
            NULLIF(t.title_en, ''),
            NULLIF(t.code, ''),
            ''
          ) AS "treatmentItem",
          ${RESOLVED_STAFF_NAME_SQL} AS "staffName"
        FROM appointments a
        LEFT JOIN customers c ON a.customer_id = c.id
        LEFT JOIN treatments t ON a.treatment_id = t.id
        ${APPOINTMENT_IDENTITY_JOINS_SQL}
        WHERE ${whereParts.join(' AND ')}
        ORDER BY a.scheduled_at DESC
        LIMIT $${params.length}
      `,
      params
    );

    assertSsotStaffRows(rows, {
      endpointLabel: '/api/visits?source=appointments',
      idFields: ['id'],
      staffFields: ['staffName'],
    });

    const normalizedRows = rows.map((row) => ({
      ...row,
      lineId: sanitizeDisplayLineId(row.lineId),
      staffName: sanitizeDisplayStaffName(row.staffName),
    }));

    return res.json({ ok: true, rows: normalizedRows });
  } catch (error) {
    if (error?.code === 'SSOT_STAFF_MISSING') {
      return res.status(500).json({
        ok: false,
        error: 'SSOT staff_name missing',
        code: error.code,
        details: error?.details || null,
      });
    }
    console.error(error);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

export async function createVisit(req, res) {
  try {
    const visitDate = requireField(req.body?.visit_date, 'visit_date');
    const visitTime = requireField(req.body?.visit_time_text, 'visit_time_text');
    const customerName = requireField(req.body?.customer_full_name, 'customer_full_name');
    const phoneRaw = requireField(req.body?.phone_raw, 'phone_raw');
    const treatmentItem = requireField(req.body?.treatment_item_text, 'treatment_item_text');
    const staffName = requireField(req.body?.staff_name, 'staff_name');

    if (!DATE_PATTERN.test(visitDate)) {
      return res.status(400).json({ ok: false, error: 'Invalid visit_date format. Use YYYY-MM-DD' });
    }
    if (!TIME_PATTERN.test(visitTime)) {
      return res.status(400).json({ ok: false, error: 'Invalid visit_time_text format. Use HH:MM' });
    }

    const lineId = normalizeText(req.body?.email_or_lineid);

    const { rows } = await query(
      `
        INSERT INTO public.sheet_visits_raw (
          sheet_uuid,
          visit_date,
          visit_time_text,
          customer_full_name,
          phone_raw,
          email_or_lineid,
          treatment_item_text,
          staff_name,
          imported_at
        )
        VALUES (
          gen_random_uuid(),
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          now()
        )
        RETURNING sheet_uuid
      `,
      [visitDate, visitTime, customerName, phoneRaw, lineId, treatmentItem, staffName]
    );

    return res.json({ ok: true, id: rows[0]?.sheet_uuid });
  } catch (error) {
    if (error?.status) {
      return res.status(error.status).json({ ok: false, error: error.message });
    }
    console.error(error);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

