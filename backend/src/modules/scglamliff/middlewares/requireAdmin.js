const ADMIN_ROLES = new Set(['admin', 'owner']);

export default function requireAdmin(req, res, next) {
  const role = String(req.user?.role_name || '').trim().toLowerCase();
  if (!ADMIN_ROLES.has(role)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  return next();
}

