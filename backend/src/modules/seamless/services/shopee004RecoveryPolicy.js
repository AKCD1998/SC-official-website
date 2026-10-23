// Operational failures are distinct from uncertain stock meaning. Only the
// bounded allowlist below is retryable; never infer safety from an error string.
const RETRY_DELAYS_MS = Object.freeze([2000, 10000, 30000, 120000]);
const TRANSIENT = new Set(['57014', '55P03', '40001', '40P01', '53300', '57P01',
  '57P02', '57P03', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
  'ENETUNREACH', 'EHOSTUNREACH', 'LEDGER_BUSY_OR_TIMEOUT', 'LEDGER_SERVICE_UNAVAILABLE']);
const SEMANTIC = new Set(['QUEUED_ORDER_MISSING', 'POS_UNIT_CONTRACT_INVALID',
  'POS_UNIT_CONTRACT_REQUIRED', 'PROJECTION_SCOPE_INVALID']);
function classifyRecoveryFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (TRANSIENT.has(code) || /^08[0-9A-Z]{3}$/.test(code)) {
    return { issueClass: 'temporary', reasonCode: code === '57014' || code === 'LEDGER_BUSY_OR_TIMEOUT'
      ? 'PROCESSING_TIMEOUT' : code === '55P03' ? 'PROCESSING_LOCK_BUSY' : 'PROCESSING_SERVICE_UNAVAILABLE', retryable: true };
  }
  return { issueClass: 'identity', reasonCode: SEMANTIC.has(code) ? code : 'PROCESSING_REVIEW_REQUIRED', retryable: false };
}
function nextRecovery({ error, attemptCount = 0, now = new Date() }) {
  const failure = classifyRecoveryFailure(error);
  const attempts = Number.isSafeInteger(attemptCount) && attemptCount >= 0 ? attemptCount + 1 : 1;
  const delay = failure.retryable && attempts <= RETRY_DELAYS_MS.length ? RETRY_DELAYS_MS[attempts - 1] : null;
  return { ...failure, attemptCount: attempts, recoveryState: delay === null ? 'blocked' : 'retry_wait',
    retryAfter: delay === null ? null : new Date(+new Date(now) + delay).toISOString(),
    exhausted: failure.retryable && delay === null };
}
function classifyReviewReason(reason) {
  if (/^(PROCESSING_|LEDGER_BUSY)/.test(reason || '')) return 'temporary';
  if (/unit|quantity|pack|factor/.test(reason || '')) return 'unit';
  if (/cancel|dispatch|return|legacy|confirmation|time|clock|order-items/.test(reason || '')) return 'lifecycle';
  return 'identity';
}
module.exports = { RETRY_DELAYS_MS, classifyRecoveryFailure, nextRecovery, classifyReviewReason };
