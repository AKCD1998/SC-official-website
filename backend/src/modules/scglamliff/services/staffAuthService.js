import bcrypt from 'bcryptjs';

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function mapTrustedStaffUser(row) {
  if (!row) return null;

  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role_name: normalizeText(row.role_name) || 'staff',
  };
}

async function recordFailedCredentialAttempt(queryFn, userId) {
  await queryFn(
    `
      UPDATE staff_users
      SET failed_login_count = failed_login_count + 1,
          updated_at = now()
      WHERE id = $1
    `,
    [userId]
  );
}

async function recordSuccessfulCredentialVerification(queryFn, userId) {
  await queryFn(
    `
      UPDATE staff_users
      SET failed_login_count = 0,
          last_login_at = now(),
          updated_at = now()
      WHERE id = $1
    `,
    [userId]
  );
}

async function resolveQueryFn(queryFn) {
  if (typeof queryFn === 'function') {
    return queryFn;
  }

  const dbModule = await import('../db.js');
  return dbModule.query;
}

export async function authenticateStaffCredentials({
  username,
  password,
  queryFn = null,
  recordAudit = true,
} = {}) {
  const resolvedQueryFn = await resolveQueryFn(queryFn);
  const normalizedUsername = normalizeText(username);
  const providedPassword = typeof password === 'string' ? password : '';

  if (!normalizedUsername || !providedPassword) {
    return {
      ok: false,
      reason: 'missing_staff_auth',
      user: null,
    };
  }

  const { rows } = await resolvedQueryFn(
    `
      SELECT
        u.id,
        u.username,
        u.display_name,
        u.password_hash,
        u.is_active,
        r.name AS role_name
      FROM staff_users u
      LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.username = $1
      LIMIT 1
    `,
    [normalizedUsername]
  );

  const user = rows[0] || null;
  const passwordOk = user ? await bcrypt.compare(providedPassword, user.password_hash) : false;

  if (!user || !user.is_active || !passwordOk) {
    if (recordAudit && user) {
      await recordFailedCredentialAttempt(resolvedQueryFn, user.id);
    }

    return {
      ok: false,
      reason: 'invalid_staff_credentials',
      user: null,
    };
  }

  if (recordAudit) {
    await recordSuccessfulCredentialVerification(resolvedQueryFn, user.id);
  }

  return {
    ok: true,
    reason: 'authenticated',
    user: mapTrustedStaffUser(user),
  };
}

export { mapTrustedStaffUser };
