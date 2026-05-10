import { buildBranchDeviceRegistrationErrorResponse } from '../services/branchDeviceRegistrationsService.js';
import { authenticateStaffCredentials } from '../services/staffAuthService.js';
import {
  recordBranchDeviceGuardResponse,
  updateBranchDeviceGuardTrace,
} from './branchDeviceGuardTrace.js';

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function buildStaffAuthError(message, reason, { status = 401 } = {}) {
  const error = new Error(message);
  error.status = status;
  error.reason = reason;
  return error;
}

function sendBranchDeviceRegistrationAuthError(req, res, error, { authMethod = null } = {}) {
  const response = buildBranchDeviceRegistrationErrorResponse(error, {
    endpoint: 'register',
    isProd: String(process.env.NODE_ENV || '').toLowerCase() === 'production',
  });

  updateBranchDeviceGuardTrace(req.branchDeviceGuardTrace, {
    failureStage:
      normalizeText(req.branchDeviceGuardTrace?.failureStage) ||
      (response.status === 401 ? 'staff_auth' : 'request'),
    errorReason: response.body?.reason || null,
    staffAuthMethod: authMethod,
  });
  recordBranchDeviceGuardResponse(req.branchDeviceGuardTrace, {
    status: response.status,
    body: response.body,
  });

  if (response.status >= 500) {
    console.error('[BranchDeviceGuard]', error);
  }

  return res.status(response.status).json(response.body);
}

async function tryCookieStaffAuth(req, res, next, requireAuthMiddleware) {
  const originalAuthFailureHandler = req.authFailureHandler;
  let authFailure = null;
  let nextCalled = false;

  req.authFailureHandler = ({ reason = 'missing_staff_auth', error = null } = {}) => {
    authFailure = { reason, error };
    return null;
  };

  try {
    await requireAuthMiddleware(req, res, () => {
      nextCalled = true;
      return undefined;
    });
  } finally {
    req.authFailureHandler = originalAuthFailureHandler;
  }

  if (nextCalled) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: authFailure?.reason || 'missing_staff_auth',
    error: authFailure?.error || null,
  };
}

async function resolveRequireAuthMiddleware(requireAuthMiddleware) {
  if (typeof requireAuthMiddleware === 'function') {
    return requireAuthMiddleware;
  }

  const authModule = await import('./requireAuth.js');
  return authModule.default;
}

export function createBranchDeviceRegistrationStaffAuthMiddleware({
  requireAuthMiddleware = null,
  authenticateStaffCredentialsFn = authenticateStaffCredentials,
} = {}) {
  return async function branchDeviceRegistrationStaffAuth(req, res, next) {
    const resolvedRequireAuthMiddleware =
      await resolveRequireAuthMiddleware(requireAuthMiddleware);
    const cookieAttempt = await tryCookieStaffAuth(req, res, next, resolvedRequireAuthMiddleware);

    if (cookieAttempt.ok) {
      updateBranchDeviceGuardTrace(req.branchDeviceGuardTrace, {
        staffAuthMethod: 'cookie',
        staffUserPresent: Boolean(normalizeText(req.user?.id)),
      });
      return next();
    }

    const staffUsername = normalizeText(req.body?.staff_username);
    const staffPassword = typeof req.body?.staff_password === 'string' ? req.body.staff_password : '';

    updateBranchDeviceGuardTrace(req.branchDeviceGuardTrace, {
      explicitStaffUsernamePresent: Boolean(staffUsername),
      explicitStaffPasswordPresent: Boolean(staffPassword),
    });

    if (!staffUsername || !staffPassword) {
      return sendBranchDeviceRegistrationAuthError(
        req,
        res,
        buildStaffAuthError(
          'Staff authentication required. Provide a valid staff cookie or explicit staff_username and staff_password.',
          'missing_staff_auth'
        ),
        { authMethod: null }
      );
    }

    try {
      const authResult = await authenticateStaffCredentialsFn({
        username: staffUsername,
        password: staffPassword,
        recordAudit: false,
      });

      if (!authResult?.ok || !authResult.user) {
        return sendBranchDeviceRegistrationAuthError(
          req,
          res,
          buildStaffAuthError('Invalid staff credentials', 'invalid_staff_credentials'),
          { authMethod: 'explicit_credentials' }
        );
      }

      req.user = authResult.user;
      updateBranchDeviceGuardTrace(req.branchDeviceGuardTrace, {
        staffAuthMethod: 'explicit_credentials',
        staffUserPresent: Boolean(normalizeText(req.user?.id)),
      });
      return next();
    } catch (error) {
      return sendBranchDeviceRegistrationAuthError(
        req,
        res,
        buildStaffAuthError(error?.message || 'Server error', 'server_error', { status: 500 }),
        { authMethod: 'explicit_credentials' }
      );
    }
  };
}

export default createBranchDeviceRegistrationStaffAuthMiddleware();
