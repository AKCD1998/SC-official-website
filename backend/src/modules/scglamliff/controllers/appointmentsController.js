import {
  ensureGasConfig,
  fetchAppointments,
  createAppointmentRecord,
  deleteAppointmentHard,
} from '../services/gasService.js';
import { query } from '../db.js';

function validatePayload(body) {
  const required = ['date', 'bookingTime', 'customerName'];
  for (const field of required) {
    if (!body || typeof body[field] !== 'string' || !body[field].trim()) {
      return field;
    }
  }
  return null;
}

export async function listAppointments(req, res) {
  if (!ensureGasConfig()) {
    return res.status(500).json({ ok: false, error: 'Server missing GAS config' });
  }

  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 500);

  try {
    const data = await fetchAppointments(limit);
    return res.json(data);
  } catch (err) {
    const status = err.name === 'AbortError' ? 504 : err.status || 500;
    return res.status(status).json({ ok: false, error: err.message || 'Upstream error' });
  }
}

export async function createAppointment(req, res) {
  if (!ensureGasConfig()) {
    return res.status(500).json({ ok: false, error: 'Server missing GAS config' });
  }

  const missingField = validatePayload(req.body);
  if (missingField) {
    return res.status(400).json({ ok: false, error: `Missing required field: ${missingField}` });
  }

  const payload = {
    date: req.body.date?.trim(),
    bookingTime: req.body.bookingTime?.trim(),
    customerName: req.body.customerName?.trim(),
    phone: req.body.phone?.trim() ?? '',
    lineId: req.body.lineId?.trim() ?? '',
    treatmentItem: req.body.treatmentItem?.trim() ?? '',
    staffName: req.body.staffName?.trim() ?? '',
  };

  try {
    const data = await createAppointmentRecord(payload);
    return res.json(data);
  } catch (err) {
    const status = err.name === 'AbortError' ? 504 : err.status || 500;
    return res.status(status).json({ ok: false, error: err.message || 'Upstream error' });
  }
}

export async function hardDeleteAppointment(req, res) {
  if (!ensureGasConfig()) {
    return res.status(500).json({ ok: false, error: 'Server missing GAS config' });
  }

  const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
  if (!id) {
    return res.status(400).json({ ok: false, error: 'Missing required field: id' });
  }

  try {
    const data = await deleteAppointmentHard(id);
    return res.json(data);
  } catch (err) {
    const status = err.name === 'AbortError' ? 504 : err.status || 500;
    return res.status(status).json({ ok: false, error: err.message || 'Upstream error' });
  }
}

export async function softDeleteAppointment(req, res) {
  const id = typeof req.params?.id === 'string' ? req.params.id.trim() : '';
  if (!id) {
    return res.status(400).json({ ok: false, error: 'Missing required parameter: id' });
  }

  try {
    const result = await query(
      `
        UPDATE appointments
        SET status = 'cancelled',
            updated_at = now()
        WHERE id = $1
          AND LOWER(COALESCE(status, '')) NOT IN ('cancelled', 'canceled')
        RETURNING id
      `,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Appointment not found' });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
