import { getLineLiffChannelId } from '../config/env.js';

const DEFAULT_ID_TOKEN_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';
const DEFAULT_ACCESS_TOKEN_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';
const DEFAULT_PROFILE_URL = 'https://api.line.me/v2/profile';

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeNullableText(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

function badRequest(message, details = null) {
  const err = new Error(message);
  err.status = 400;
  err.reason = 'missing_token';
  if (details) {
    err.details = details;
  }
  return err;
}

function unauthorized(message, code) {
  const err = new Error(message);
  err.status = 401;
  err.reason = 'invalid_token';
  if (code) {
    err.code = code;
  }
  return err;
}

function serverConfigError(message) {
  const err = new Error(message);
  err.status = 500;
  err.code = 'LINE_LIFF_CONFIG_MISSING';
  err.reason = 'config_error';
  return err;
}

function parseBearerToken(rawAuthorization) {
  const text = normalizeText(rawAuthorization);
  if (!text) return '';
  const match = text.match(/^Bearer\s+(.+)$/i);
  return normalizeText(match?.[1]);
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function resolveLineChannelId(explicitChannelId = '') {
  return (
    normalizeText(explicitChannelId) ||
    normalizeText(getLineLiffChannelId())
  );
}

export function extractLineCredentialPayload({ headers = {}, body = {} } = {}) {
  const authorizationAccessToken = parseBearerToken(headers?.authorization);
  const headerAccessToken =
    normalizeText(headers?.['x-line-access-token']) || authorizationAccessToken;
  const bodyAccessToken = normalizeText(body?.access_token);
  const accessToken = headerAccessToken || bodyAccessToken;

  const idToken =
    normalizeText(headers?.['x-line-id-token']) || normalizeText(body?.id_token);
  const liffAppId =
    normalizeNullableText(headers?.['x-liff-app-id']) ||
    normalizeNullableText(body?.liff_app_id);

  if (!idToken && !accessToken) {
    throw badRequest('Missing LINE LIFF token. Provide id_token and/or access_token.');
  }

  return {
    idToken,
    accessToken,
    liffAppId,
  };
}

async function verifyLineIdToken({
  idToken,
  channelId,
  fetchImpl,
  idTokenVerifyUrl = DEFAULT_ID_TOKEN_VERIFY_URL,
}) {
  const resolvedChannelId = resolveLineChannelId(channelId);
  if (!resolvedChannelId) {
    throw serverConfigError(
      'SCGLAMLIFF_LINE_CHANNEL_ID is required to verify LINE id_token'
    );
  }

  const body = new URLSearchParams();
  body.set('id_token', idToken);
  body.set('client_id', resolvedChannelId);

  const response = await fetchImpl(idTokenVerifyUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const payload = await safeJson(response);
  if (!response.ok) {
    throw unauthorized('LINE id_token verification failed', 'LINE_ID_TOKEN_INVALID');
  }

  const lineUserId = normalizeText(payload?.sub || payload?.userId);
  const audience = normalizeText(payload?.aud || payload?.client_id);

  if (!lineUserId) {
    throw unauthorized('LINE id_token verification failed', 'LINE_ID_TOKEN_INVALID');
  }
  if (!audience || audience !== resolvedChannelId) {
    throw unauthorized('LINE id_token audience mismatch', 'LINE_ID_TOKEN_AUDIENCE_MISMATCH');
  }

  return {
    line_user_id: lineUserId,
    display_name: normalizeNullableText(payload?.name),
    picture_url: normalizeNullableText(payload?.picture),
    verification_source: 'id_token',
  };
}

async function verifyLineAccessToken({
  accessToken,
  channelId,
  fetchImpl,
  accessTokenVerifyUrl = DEFAULT_ACCESS_TOKEN_VERIFY_URL,
  profileUrl = DEFAULT_PROFILE_URL,
}) {
  const resolvedChannelId = resolveLineChannelId(channelId);
  if (!resolvedChannelId) {
    throw serverConfigError(
      'SCGLAMLIFF_LINE_CHANNEL_ID is required to verify LINE access_token'
    );
  }

  const verifyUrl = new URL(accessTokenVerifyUrl);
  verifyUrl.searchParams.set('access_token', accessToken);

  const verifyResponse = await fetchImpl(verifyUrl.toString(), {
    method: 'GET',
  });
  const verifyPayload = await safeJson(verifyResponse);
  if (!verifyResponse.ok) {
    throw unauthorized('LINE access_token verification failed', 'LINE_ACCESS_TOKEN_INVALID');
  }

  const clientId = normalizeText(verifyPayload?.client_id || verifyPayload?.aud);
  if (!clientId || clientId !== resolvedChannelId) {
    throw unauthorized(
      'LINE access_token audience mismatch',
      'LINE_ACCESS_TOKEN_AUDIENCE_MISMATCH'
    );
  }

  const profileResponse = await fetchImpl(profileUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const profilePayload = await safeJson(profileResponse);
  if (!profileResponse.ok) {
    throw unauthorized('LINE profile lookup failed', 'LINE_PROFILE_LOOKUP_FAILED');
  }

  const lineUserId = normalizeText(profilePayload?.userId || profilePayload?.sub);
  if (!lineUserId) {
    throw unauthorized('LINE profile lookup failed', 'LINE_PROFILE_LOOKUP_FAILED');
  }

  return {
    line_user_id: lineUserId,
    display_name: normalizeNullableText(profilePayload?.displayName),
    picture_url: normalizeNullableText(profilePayload?.pictureUrl),
    verification_source: 'access_token',
  };
}

export async function verifyLineLiffIdentity({
  idToken = '',
  accessToken = '',
  liffAppId = '',
  channelId = '',
  fetchImpl = globalThis.fetch,
  idTokenVerifyUrl = DEFAULT_ID_TOKEN_VERIFY_URL,
  accessTokenVerifyUrl = DEFAULT_ACCESS_TOKEN_VERIFY_URL,
  profileUrl = DEFAULT_PROFILE_URL,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is required for LINE LIFF verification');
  }

  const normalizedIdToken = normalizeText(idToken);
  const normalizedAccessToken = normalizeText(accessToken);

  if (!normalizedIdToken && !normalizedAccessToken) {
    throw badRequest('Missing LINE LIFF token. Provide id_token and/or access_token.');
  }

  const idIdentity = normalizedIdToken
    ? await verifyLineIdToken({
        idToken: normalizedIdToken,
        channelId,
        fetchImpl,
        idTokenVerifyUrl,
      })
    : null;

  const accessIdentity = normalizedAccessToken
    ? await verifyLineAccessToken({
        accessToken: normalizedAccessToken,
        channelId,
        fetchImpl,
        accessTokenVerifyUrl,
        profileUrl,
      })
    : null;

  if (
    idIdentity &&
    accessIdentity &&
    normalizeText(idIdentity.line_user_id) !== normalizeText(accessIdentity.line_user_id)
  ) {
    throw unauthorized(
      'LINE id_token and access_token resolved to different users',
      'LINE_IDENTITY_MISMATCH'
    );
  }

  const trustedIdentity = idIdentity || accessIdentity;
  if (!trustedIdentity?.line_user_id) {
    throw unauthorized('Unable to resolve verified LINE identity', 'LINE_IDENTITY_UNAVAILABLE');
  }

  return {
    line_user_id: trustedIdentity.line_user_id,
    display_name:
      trustedIdentity.display_name ||
      accessIdentity?.display_name ||
      idIdentity?.display_name ||
      null,
    picture_url:
      trustedIdentity.picture_url ||
      accessIdentity?.picture_url ||
      idIdentity?.picture_url ||
      null,
    liff_app_id: normalizeNullableText(liffAppId),
    verification_source:
      idIdentity && accessIdentity
        ? 'id_token+access_token'
        : trustedIdentity.verification_source,
  };
}

export { normalizeText };
