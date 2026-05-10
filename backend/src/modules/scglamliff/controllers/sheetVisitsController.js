import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { pool } from '../db.js';
import { getPinFingerprintSecret } from '../config/env.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fingerprintPin(pin) {
  return crypto
    .createHmac('sha256', getPinFingerprintSecret())
    .update(pin)
    .digest('hex');
}

async function findOrCreateStaff(client, user) {
  const userId = user?.id;
  const displayName = user?.display_name || user?.username || '';

  if (!userId) {
    throw new Error('Missing user id');
  }

  const existingById = await client.query(
    'SELECT id, pin_hash, pin_fingerprint FROM staffs WHERE id = $1',
    [userId]
  );
  if (existingById.rows.length > 0) {
    return existingById.rows[0];
  }

  if (displayName) {
    const existingByName = await client.query(
      'SELECT id, pin_hash, pin_fingerprint FROM staffs WHERE display_name = $1',
      [displayName]
    );
    if (existingByName.rows.length > 0) {
      return existingByName.rows[0];
    }
  }

  const safeName = displayName || `staff-${userId}`;
  const inserted = await client.query(
    'INSERT INTO staffs (id, display_name, is_active) VALUES ($1, $2, true) RETURNING id, pin_hash, pin_fingerprint',
    [userId, safeName]
  );

  return inserted.rows[0];
}

async function ensurePinUnique(client, fingerprint, staffId) {
  const { rows } = await client.query(
    'SELECT id FROM staffs WHERE pin_fingerprint = $1 AND id <> $2 LIMIT 1',
    [fingerprint, staffId]
  );
  if (rows.length > 0) {
    const err = new Error('PIN is already used by another staff');
    err.status = 409;
    throw err;
  }
}

async function setPinForStaff(client, staffId, pin) {
  const fingerprint = fingerprintPin(pin);
  await ensurePinUnique(client, fingerprint, staffId);
  const pinHash = await bcrypt.hash(pin, 10);
  await client.query(
    'UPDATE staffs SET pin_hash = $1, pin_fingerprint = $2 WHERE id = $3',
    [pinHash, fingerprint, staffId]
  );
  return fingerprint;
}

export async function deleteSheetVisit(req, res) {
  if (!getPinFingerprintSecret()) {
    return res.status(500).json({ ok: false, error: 'Server missing PIN secret' });
  }

  const sheetUuid = typeof req.params?.sheetUuid === 'string' ? req.params.sheetUuid.trim() : '';
  const pin = typeof req.body?.pin === 'string' ? req.body.pin.trim() : '';
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

  if (!sheetUuid || !UUID_PATTERN.test(sheetUuid)) {
    return res.status(400).json({ ok: false, error: 'Invalid sheet UUID' });
  }
  if (!pin) {
    return res.status(400).json({ ok: false, error: 'PIN is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const staff = await findOrCreateStaff(client, req.user);
    const staffId = staff.id;

    if (!staff.pin_hash) {
      await setPinForStaff(client, staffId, pin);
    } else {
      const matches = await bcrypt.compare(pin, staff.pin_hash);
      if (!matches) {
        await client.query('ROLLBACK');
        return res.status(401).json({ ok: false, error: 'Invalid PIN' });
      }

      if (!staff.pin_fingerprint) {
        await setPinForStaff(client, staffId, pin);
      }
    }

    const updateResult = await client.query(
      `
        UPDATE sheet_visits_raw
        SET deleted_at = now(),
            deleted_by_staff_id = $2,
            delete_note = $3
        WHERE sheet_uuid = $1 AND deleted_at IS NULL
        RETURNING sheet_uuid
      `,
      [sheetUuid, staffId, reason || null]
    );

    if (updateResult.rowCount === 0) {
      const check = await client.query(
        'SELECT deleted_at FROM sheet_visits_raw WHERE sheet_uuid = $1',
        [sheetUuid]
      );
      await client.query('ROLLBACK');
      if (check.rowCount === 0) {
        return res.status(404).json({ ok: false, error: 'Row not found' });
      }
      return res.status(409).json({ ok: false, error: 'Row already deleted' });
    }

    const meta = {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };

    await client.query(
      `
        INSERT INTO sheet_visits_deletions (sheet_uuid, staff_id, reason, meta)
        VALUES ($1, $2, $3, $4::jsonb)
      `,
      [sheetUuid, staffId, reason || null, JSON.stringify(meta)]
    );

    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.status) {
      return res.status(error.status).json({ ok: false, error: error.message });
    }
    console.error(error);
    return res.status(500).json({ ok: false, error: 'Server error' });
  } finally {
    client.release();
  }
}
