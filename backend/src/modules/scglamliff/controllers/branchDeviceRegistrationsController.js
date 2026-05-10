import {
  buildBranchDeviceRegistrationMeResponse,
  buildBranchDeviceRegistrationMutationResponse,
  buildBranchDeviceRegistrationErrorResponse,
  createOrUpdateBranchDeviceRegistration,
  getBranchDeviceRegistrationMe,
  listBranchDeviceRegistrations,
  patchBranchDeviceRegistration,
} from '../services/branchDeviceRegistrationsService.js';
import {
  recordBranchDeviceGuardResponse,
  updateBranchDeviceGuardTrace,
} from '../middlewares/branchDeviceGuardTrace.js';

export function applyBranchDeviceErrorTrace(trace, { status = null, body = null } = {}) {
  if (!trace || typeof trace !== 'object') {
    return;
  }

  const responseReason = body?.reason || null;
  const patch = {
    errorReason: responseReason,
  };

  if (!trace.failureStage && typeof status === 'number' && status >= 500) {
    patch.failureStage = trace.liffVerification === 'success' ? 'registration_lookup' : 'request';
  }

  if (!trace.verificationReason && trace.liffVerification !== 'success') {
    patch.verificationReason = responseReason;
  }

  updateBranchDeviceGuardTrace(trace, patch);
}

function sendBranchDeviceRegistrationError(req, res, error, endpoint) {
  const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  const response = buildBranchDeviceRegistrationErrorResponse(error, {
    endpoint,
    isProd,
  });
  applyBranchDeviceErrorTrace(req.branchDeviceGuardTrace, {
    status: response.status,
    body: response.body,
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

export async function createOrUpdateBranchDeviceRegistrationHandler(req, res) {
  try {
    const result = await createOrUpdateBranchDeviceRegistration({
      body: req.body,
      headers: req.headers,
      user: req.user,
      trace: req.branchDeviceGuardTrace,
    });
    const body = buildBranchDeviceRegistrationMutationResponse(result);
    const status = result.action === 'created' ? 201 : 200;
    recordBranchDeviceGuardResponse(req.branchDeviceGuardTrace, {
      status,
      body,
    });
    return res.status(status).json(body);
  } catch (error) {
    return sendBranchDeviceRegistrationError(req, res, error, 'register');
  }
}

export async function listBranchDeviceRegistrationsHandler(req, res) {
  try {
    const result = await listBranchDeviceRegistrations({
      status: req.query?.status,
      branchId: req.query?.branch_id,
      lineUserId: req.query?.line_user_id,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return sendBranchDeviceRegistrationError(req, res, error, 'generic');
  }
}

export async function getBranchDeviceRegistrationMeHandler(req, res) {
  try {
    const result = await getBranchDeviceRegistrationMe({
      headers: req.headers,
      body: req.body,
      trace: req.branchDeviceGuardTrace,
    });
    const body = buildBranchDeviceRegistrationMeResponse(result);
    recordBranchDeviceGuardResponse(req.branchDeviceGuardTrace, {
      status: 200,
      body,
    });
    return res.status(200).json(body);
  } catch (error) {
    return sendBranchDeviceRegistrationError(req, res, error, 'me');
  }
}

export async function patchBranchDeviceRegistrationHandler(req, res) {
  try {
    const registration = await patchBranchDeviceRegistration({
      registrationId: req.params?.id,
      body: req.body,
      user: req.user,
    });
    return res.json({ ok: true, registration });
  } catch (error) {
    return sendBranchDeviceRegistrationError(req, res, error, 'generic');
  }
}
