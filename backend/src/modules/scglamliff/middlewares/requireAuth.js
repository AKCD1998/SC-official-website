import jwt from 'jsonwebtoken';
import { query } from '../db.js';
import { getJwtSecret } from '../config/env.js';
import {
  AUTH_COOKIE_NAME,
  logStaffAuthEvent,
  summarizeStaffAuthRequest,
} from '../utils/staffAuthSession.js';

function isAuthMeRequest(req) {
  return String(req.originalUrl || req.url || '').endsWith('/auth/me');
}

function logAuthMeEvent(event, req, payload = {}) {
  if (!isAuthMeRequest(req)) {
    return;
  }

  logStaffAuthEvent(event, {
    ...summarizeStaffAuthRequest(req),
    ...payload,
  });
}

function sendUnauthorized(req, res, { reason = 'missing_staff_auth', error = null } = {}) {
  if (typeof req.authFailureHandler === 'function') {
    return req.authFailureHandler({ reason, error });
  }

  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

export default async function requireAuth(req, res, next) {
  logAuthMeEvent('auth_me_check', req);

  try {
    const token = req.cookies?.[AUTH_COOKIE_NAME];
    if (!token) {
      logAuthMeEvent('auth_me_missing_cookie', req, {
        authFailureReason: 'missing_staff_auth',
      });
      return sendUnauthorized(req, res, { reason: 'missing_staff_auth' });
    }

    const payload = jwt.verify(token, getJwtSecret(), { audience: 'scglamliff' });

    const { rows } = await query(
      `
        SELECT u.id, u.username, u.display_name, r.name AS role_name
        FROM staff_users u
        LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.id = $1 AND u.is_active = true
      `,
      [payload.sub]
    );

    if (rows.length === 0) {
      logAuthMeEvent('auth_me_missing_user', req, {
        authFailureReason: 'missing_staff_auth',
        tokenSubject: payload?.sub || null,
      });
      return sendUnauthorized(req, res, { reason: 'missing_staff_auth' });
    }

    req.user = rows[0];
    logAuthMeEvent('auth_me_verified', req, {
      userId: req.user?.id || null,
      username: req.user?.username || null,
      roleName: req.user?.role_name || null,
    });
    return next();
  } catch (error) {
    logAuthMeEvent('auth_me_failed', req, {
      authFailureReason: 'missing_staff_auth',
      jwtErrorName: error?.name || null,
      jwtErrorMessage: error?.message || null,
    });
    return sendUnauthorized(req, res, {
      reason: 'missing_staff_auth',
      error,
    });
  }
}
