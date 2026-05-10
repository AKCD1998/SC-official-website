import { isProductionRuntime, readScGlamLiffEnv } from '../config/env.js';

const AUTH_LOG_PREFIX = '[StaffAuth]';

export const AUTH_COOKIE_NAME = 'scglamliff_token';
export const AUTH_TOKEN_EXPIRES_IN = '7d';
export const AUTH_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeText(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}

function normalizeSameSiteValue(value) {
  const normalized = normalizeText(value).toLowerCase();
  return ['lax', 'strict', 'none'].includes(normalized) ? normalized : '';
}

function extractCookieNames(cookieHeader) {
  const normalized = normalizeText(cookieHeader);

  if (!normalized) {
    return [];
  }

  return normalized
    .split(';')
    .map((part) => normalizeText(part).split('=')[0])
    .map((name) => normalizeText(name))
    .filter(Boolean);
}

function normalizeSetCookieHeaders(setCookieHeader) {
  if (Array.isArray(setCookieHeader)) {
    return setCookieHeader
      .map((headerValue) => normalizeText(headerValue))
      .filter(Boolean);
  }

  const normalizedHeader = normalizeText(setCookieHeader);
  return normalizedHeader ? [normalizedHeader] : [];
}

export function buildStaffSessionCookieOptions() {
  const requestedSameSite = normalizeSameSiteValue(readScGlamLiffEnv('SCGLAMLIFF_COOKIE_SAMESITE'));
  const sameSite = requestedSameSite || (isProductionRuntime() ? 'none' : 'lax');
  const secure =
    normalizeText(readScGlamLiffEnv('SCGLAMLIFF_COOKIE_SECURE')).toLowerCase() === 'true' ||
    sameSite === 'none' ||
    isProductionRuntime();
  const domain = normalizeText(readScGlamLiffEnv('SCGLAMLIFF_COOKIE_DOMAIN'));

  return {
    httpOnly: true,
    sameSite,
    secure,
    path: '/',
    maxAge: AUTH_TOKEN_MAX_AGE_MS,
    ...(domain ? { domain } : {}),
  };
}

export function buildStaffSessionClearCookieOptions() {
  const { maxAge, ...cookieOptions } = buildStaffSessionCookieOptions();
  return cookieOptions;
}

export function summarizeStaffSessionCookieOptions(cookieOptions = {}) {
  return {
    name: AUTH_COOKIE_NAME,
    httpOnly: Boolean(cookieOptions.httpOnly),
    sameSite: normalizeText(cookieOptions.sameSite) || null,
    secure: Boolean(cookieOptions.secure),
    path: normalizeText(cookieOptions.path) || null,
    domain: normalizeText(cookieOptions.domain) || null,
    maxAge: Number.isFinite(cookieOptions.maxAge) ? cookieOptions.maxAge : null,
  };
}

export function summarizeStaffAuthRequest(req = {}) {
  const cookieHeader = normalizeText(req.headers?.cookie);

  return {
    method: normalizeText(req.method).toUpperCase() || null,
    path: normalizeText(req.originalUrl || req.url) || null,
    host: normalizeText(req.headers?.host) || null,
    origin: normalizeText(req.headers?.origin) || null,
    referer: normalizeText(req.headers?.referer) || null,
    requestId:
      normalizeText(req.headers?.['x-request-id'] || req.headers?.['x-render-request-id']) ||
      null,
    userAgent: normalizeText(req.headers?.['user-agent']) || null,
    secFetchSite: normalizeText(req.headers?.['sec-fetch-site']) || null,
    cookieHeaderPresent: Boolean(cookieHeader),
    cookieNames: extractCookieNames(cookieHeader),
    parsedTokenPresent: Boolean(normalizeText(req.cookies?.[AUTH_COOKIE_NAME])),
  };
}

export function summarizeSetCookieHeaders(setCookieHeader) {
  const normalizedHeaders = normalizeSetCookieHeaders(setCookieHeader);

  return {
    setCookieHeaderPresent: normalizedHeaders.length > 0,
    setCookieHeaderCount: normalizedHeaders.length,
    setCookieCookieNames: normalizedHeaders
      .map((headerValue) => extractCookieNames(headerValue)[0] || null)
      .filter(Boolean),
  };
}

export function logStaffAuthEvent(event, payload = {}) {
  console.log(
    AUTH_LOG_PREFIX,
    JSON.stringify({
      event,
      ...payload,
    })
  );
}
