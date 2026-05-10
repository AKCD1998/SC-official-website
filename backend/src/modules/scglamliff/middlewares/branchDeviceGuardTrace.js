import { buildBranchDeviceRegistrationErrorResponse } from '../services/branchDeviceRegistrationsService.js';

const LOG_PREFIX = '[BranchDeviceGuard]';

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeNullableText(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

function maskLineUserId(lineUserId) {
  const normalized = normalizeText(lineUserId);
  if (!normalized) return null;
  if (normalized.length <= 8) {
    return `${normalized.slice(0, 2)}***${normalized.slice(-2)}`;
  }
  return `${normalized.slice(0, 4)}***${normalized.slice(-4)}`;
}

function buildResponseSummary(body = {}) {
  return {
    success:
      typeof body?.success === 'boolean'
        ? body.success
        : typeof body?.ok === 'boolean'
          ? body.ok
          : null,
    reason: normalizeNullableText(body?.reason),
    registered:
      typeof body?.registered === 'boolean' ? body.registered : null,
    active:
      typeof body?.active === 'boolean' || body?.active === null
        ? body.active
        : null,
    created: typeof body?.created === 'boolean' ? body.created : null,
    updated: typeof body?.updated === 'boolean' ? body.updated : null,
    branchIdPresent: Boolean(body?.branchId || body?.branch_id),
    registrationIdPresent: Boolean(
      body?.registrationId || body?.registration?.id
    ),
    hasError: Boolean(normalizeText(body?.error)),
    payloadKeys:
      body && typeof body === 'object' ? Object.keys(body).sort() : [],
  };
}

function buildInitialTrace(req, endpoint) {
  const authorizationHeader = normalizeText(req.headers?.authorization);
  const idToken =
    normalizeText(req.headers?.['x-line-id-token']) ||
    normalizeText(req.body?.id_token);
  const accessToken =
    normalizeText(req.headers?.['x-line-access-token']) ||
    authorizationHeader ||
    normalizeText(req.body?.access_token);
  const liffAppId =
    normalizeText(req.headers?.['x-liff-app-id']) ||
    normalizeText(req.body?.liff_app_id);
  const branchId =
    normalizeText(req.body?.branch_id) || normalizeText(req.query?.branch_id);

  return {
    endpoint,
    method: normalizeText(req.method),
    path: normalizeText(req.originalUrl || req.path),
    host: normalizeNullableText(req.headers?.host),
    origin: normalizeNullableText(req.headers?.origin),
    requestId:
      normalizeNullableText(req.headers?.['x-request-id']) ||
      normalizeNullableText(req.headers?.['x-render-request-id']),
    authorizationHeaderPresent: Boolean(authorizationHeader),
    idTokenPresent: Boolean(idToken),
    accessTokenPresent: Boolean(accessToken),
    liffTokenPresent: Boolean(idToken || accessToken),
    liffAppIdPresent: Boolean(liffAppId),
    staffCookiePresent: Boolean(normalizeText(req.cookies?.token)),
    staffUserPresent: Boolean(normalizeText(req.user?.id)),
    explicitStaffUsernamePresent: Boolean(normalizeText(req.body?.staff_username)),
    explicitStaffPasswordPresent: Boolean(
      typeof req.body?.staff_password === 'string' && req.body.staff_password.length > 0
    ),
    staffAuthMethod: null,
    branchIdPresent: Boolean(branchId),
    branchId: branchId || null,
    liffVerification: 'not_started',
    verificationReason: null,
    failureStage: null,
    errorReason: null,
    lookupFailure: null,
    resolvedLineUserId: null,
    lookupResult: null,
    finalStatus: null,
    responseSummary: null,
  };
}

function logTrace(event, trace) {
  console.log(
    LOG_PREFIX,
    JSON.stringify({
      event,
      ...trace,
    })
  );
}

export function updateBranchDeviceGuardTrace(trace, patch = {}) {
  if (!trace || typeof trace !== 'object') {
    return;
  }

  Object.assign(trace, patch);
}

export function recordBranchDeviceGuardResponse(trace, { status, body } = {}) {
  updateBranchDeviceGuardTrace(trace, {
    finalStatus: typeof status === 'number' ? status : null,
    responseSummary: buildResponseSummary(body),
  });
}

export function createBranchDeviceGuardTraceMiddleware(endpoint) {
  return function branchDeviceGuardTraceMiddleware(req, res, next) {
    const trace = buildInitialTrace(req, endpoint);
    req.branchDeviceGuardTrace = trace;

    if (endpoint === 'register') {
      req.authFailureHandler = ({ reason = 'missing_staff_auth', error = null } = {}) => {
        const authError = error || new Error('Unauthorized');
        authError.status = 401;
        authError.reason = reason;

        const response = buildBranchDeviceRegistrationErrorResponse(authError, {
          endpoint: 'register',
          isProd: String(process.env.NODE_ENV || '').toLowerCase() === 'production',
        });

        updateBranchDeviceGuardTrace(trace, {
          failureStage: 'staff_auth',
          errorReason: normalizeNullableText(reason),
        });
        recordBranchDeviceGuardResponse(trace, {
          status: response.status,
          body: response.body,
        });

        return res.status(response.status).json(response.body);
      };
    }

    logTrace('route_hit', trace);

    res.on('finish', () => {
      if (trace.finalStatus === null) {
        trace.finalStatus = res.statusCode;
      }
      logTrace('route_complete', trace);
    });

    next();
  };
}

export { LOG_PREFIX, maskLineUserId };
