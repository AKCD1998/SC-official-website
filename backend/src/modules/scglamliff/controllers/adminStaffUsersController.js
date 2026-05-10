import bcrypt from 'bcryptjs';
import { query } from '../db.js';

const ALLOWED_ROLES = new Set(['staff', 'admin', 'owner']);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeRoleName(value) {
  const role = normalizeText(value || 'staff').toLowerCase();
  return role || 'staff';
}

function toStaffUserDto(row = {}) {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role_name: row.role_name || 'staff',
    is_active: Boolean(row.is_active),
    created_at: row.created_at || null,
  };
}

export async function listAdminStaffUsers(req, res) {
  try {
    const result = await query(
      `
        SELECT
          u.id,
          u.username,
          u.display_name,
          r.name AS role_name,
          u.is_active,
          u.created_at
        FROM staff_users u
        LEFT JOIN roles r ON r.id = u.role_id
        ORDER BY u.created_at DESC, u.username ASC
      `
    );

    return res.json({
      ok: true,
      rows: result.rows.map(toStaffUserDto),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

export async function createAdminStaffUser(req, res) {
  try {
    const username = normalizeText(req.body?.username);
    const password = String(req.body?.password ?? '');
    const displayNameInput = normalizeText(req.body?.display_name);
    const roleName = normalizeRoleName(req.body?.role_name);
    const isActiveInput = req.body?.is_active;

    if (!username) {
      return res.status(400).json({ ok: false, error: 'username is required' });
    }

    if (!password) {
      return res.status(400).json({ ok: false, error: 'password is required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ ok: false, error: 'password must be at least 6 characters' });
    }

    if (!ALLOWED_ROLES.has(roleName)) {
      return res.status(400).json({ ok: false, error: 'role_name must be staff, admin, or owner' });
    }

    let isActive = true;
    if (isActiveInput !== undefined) {
      if (typeof isActiveInput !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'is_active must be a boolean' });
      }
      isActive = isActiveInput;
    }

    const existing = await query(
      `
        SELECT id
        FROM staff_users
        WHERE username = $1
        LIMIT 1
      `,
      [username]
    );
    if (existing.rowCount > 0) {
      return res.status(409).json({ ok: false, error: 'Username already exists' });
    }

    const roleResult = await query(
      `
        INSERT INTO roles (name)
        VALUES ($1)
        ON CONFLICT (name)
        DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      `,
      [roleName]
    );
    const roleId = roleResult.rows[0]?.id || null;
    if (!roleId) {
      return res.status(500).json({ ok: false, error: 'Unable to resolve role_id' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const displayName = displayNameInput || username;

    const inserted = await query(
      `
        INSERT INTO staff_users (username, display_name, password_hash, role_id, is_active)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, username, display_name, is_active, created_at, updated_at
      `,
      [username, displayName, passwordHash, roleId, isActive]
    );

    const user = inserted.rows[0];
    return res.status(201).json({
      ok: true,
      data: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        role_name: roleName,
        is_active: user.is_active,
        created_at: user.created_at,
        updated_at: user.updated_at,
      },
    });
  } catch (error) {
    if (error?.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Username already exists' });
    }
    console.error(error);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

export async function patchAdminStaffUser(req, res) {
  try {
    const userId = normalizeText(req.params?.id);
    if (!userId || !UUID_PATTERN.test(userId)) {
      return res.status(400).json({ ok: false, error: 'Invalid user id' });
    }

    const body = req.body || {};
    const hasIsActive = Object.prototype.hasOwnProperty.call(body, 'is_active');
    const hasPassword = Object.prototype.hasOwnProperty.call(body, 'password');

    if (!hasIsActive && !hasPassword) {
      return res.status(400).json({
        ok: false,
        error: 'At least one field is required: is_active or password',
      });
    }

    let nextIsActive = null;
    if (hasIsActive) {
      if (typeof body.is_active !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'is_active must be a boolean' });
      }
      nextIsActive = body.is_active;
    }

    let nextPasswordHash = null;
    if (hasPassword) {
      const nextPassword = String(body.password ?? '');
      if (!nextPassword || nextPassword.length < 6) {
        return res.status(400).json({ ok: false, error: 'password must be at least 6 characters' });
      }
      nextPasswordHash = await bcrypt.hash(nextPassword, 10);
    }

    const updated = await query(
      `
        UPDATE staff_users
        SET
          is_active = COALESCE($2::boolean, is_active),
          password_hash = COALESCE($3::text, password_hash),
          updated_at = now()
        WHERE id = $1
        RETURNING id, username, display_name, is_active, created_at, role_id
      `,
      [userId, nextIsActive, nextPasswordHash]
    );

    if (updated.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    const userRow = updated.rows[0];
    const roleRow = await query('SELECT name FROM roles WHERE id = $1 LIMIT 1', [userRow.role_id]);
    return res.json({
      ok: true,
      data: toStaffUserDto({
        ...userRow,
        role_name: roleRow.rows[0]?.name || 'staff',
      }),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
