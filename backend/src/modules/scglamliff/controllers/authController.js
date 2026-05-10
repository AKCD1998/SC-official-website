import jwt from 'jsonwebtoken';
import { authenticateStaffCredentials } from '../services/staffAuthService.js';
import { getJwtSecret } from '../config/env.js';
import {
  AUTH_COOKIE_NAME,
  AUTH_TOKEN_EXPIRES_IN,
  buildStaffSessionClearCookieOptions,
  buildStaffSessionCookieOptions,
  logStaffAuthEvent,
  summarizeStaffAuthRequest,
  summarizeSetCookieHeaders,
  summarizeStaffSessionCookieOptions,
} from '../utils/staffAuthSession.js';

const cookieOptions = buildStaffSessionCookieOptions();
const clearCookieOptions = buildStaffSessionClearCookieOptions();
const cookieSummary = summarizeStaffSessionCookieOptions(cookieOptions);

export async function login(req, res) {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'Missing credentials' });
    }

    const authResult = await authenticateStaffCredentials({
      username,
      password,
      recordAudit: true,
    });

    if (!authResult.ok || !authResult.user) {
      return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    }

    const user = authResult.user;

    const token = jwt.sign({ sub: user.id, aud: 'scglamliff' }, getJwtSecret(), {
      expiresIn: AUTH_TOKEN_EXPIRES_IN,
    });

    res.cookie(AUTH_COOKIE_NAME, token, cookieOptions);
    logStaffAuthEvent('login_success', {
      ...summarizeStaffAuthRequest(req),
      userId: user.id,
      username: user.username,
      cookie: cookieSummary,
      ...summarizeSetCookieHeaders(res.getHeader('Set-Cookie')),
    });
    return res.json({
      ok: true,
      data: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
      },
    });
  } catch (error) {
    logStaffAuthEvent('login_failed_internal', {
      ...summarizeStaffAuthRequest(req),
      attemptedUsername: typeof req.body?.username === 'string' ? req.body.username.trim() || null : null,
      errorName: error?.name || null,
      errorMessage: error?.message || null,
    });
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

export function me(req, res) {
  logStaffAuthEvent('auth_me_success', {
    ...summarizeStaffAuthRequest(req),
    userId: req.user?.id || null,
    username: req.user?.username || null,
  });
  return res.json({ ok: true, data: req.user });
}

export function logout(req, res) {
  res.clearCookie(AUTH_COOKIE_NAME, clearCookieOptions);
  return res.json({ ok: true, data: { message: 'Logged out' } });
}
