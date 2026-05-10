import { isLegacySheetModeEnabled } from '../config/env.js';

function legacySheetEnabled() {
  return isLegacySheetModeEnabled();
}

function isAdminRole(roleName) {
  const role = String(roleName || '').trim().toLowerCase();
  return role === 'admin' || role === 'owner';
}

export default function legacySheetGuard(req, res, next) {
  if (isAdminRole(req.user?.role_name)) {
    return next();
  }

  if (legacySheetEnabled()) {
    return next();
  }

  return res.status(410).json({ ok: false, error: 'Legacy sheet endpoints are disabled' });
}
