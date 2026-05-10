export function toNonNegativeInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(Math.trunc(parsed), 0);
}

export function computePackageRemaining({
  sessionsTotal = 0,
  sessionsUsed = 0,
  maskTotal = 0,
  maskUsed = 0,
} = {}) {
  const safeSessionsTotal = toNonNegativeInt(sessionsTotal);
  const safeSessionsUsed = toNonNegativeInt(sessionsUsed);
  const safeMaskTotal = toNonNegativeInt(maskTotal);
  const safeMaskUsed = toNonNegativeInt(maskUsed);

  return {
    sessions_total: safeSessionsTotal,
    sessions_used: safeSessionsUsed,
    sessions_remaining: Math.max(safeSessionsTotal - safeSessionsUsed, 0),
    mask_total: safeMaskTotal,
    mask_used: safeMaskUsed,
    mask_remaining: Math.max(safeMaskTotal - safeMaskUsed, 0),
  };
}

export function deriveContinuousPackageStatus(currentStatus, sessionsRemaining) {
  const normalizedCurrent = String(currentStatus || '').trim().toLowerCase();
  const safeRemaining = toNonNegativeInt(sessionsRemaining);

  if (normalizedCurrent === 'active' && safeRemaining <= 0) {
    return 'completed';
  }
  if (normalizedCurrent === 'completed' && safeRemaining > 0) {
    return 'active';
  }
  return normalizedCurrent || String(currentStatus || '').trim();
}

export function shouldShortCircuitCompletedAppointment(status) {
  return String(status || '').trim().toLowerCase() === 'completed';
}
