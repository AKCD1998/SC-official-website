// Operational failures are distinct from uncertain stock meaning. Only the
// bounded allowlist below is retryable; never infer safety from an error string.
const RETRY_DELAYS_MS = Object.freeze([2000, 10000, 30000, 120000]);
const TRANSIENT = new Set(['57014', '55P03', '40001', '40P01', '53300', '57P01',
  '57P02', '57P03', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
  'ENETUNREACH', 'EHOSTUNREACH', 'LEDGER_BUSY_OR_TIMEOUT', 'LEDGER_SERVICE_UNAVAILABLE',
  'LEDGER_CONNECTION_ACQUIRE_TIMEOUT','LEDGER_CONNECTION_QUEUE_FULL','LEDGER_CONNECTION_UNAVAILABLE','LEDGER_QUERY_OUTCOME_UNKNOWN',
  'IDENTITY_REVISION_CONFLICT']);
const SEMANTIC = new Set(['QUEUED_ORDER_MISSING', 'POS_UNIT_CONTRACT_INVALID',
  'POS_UNIT_CONTRACT_REQUIRED', 'PROJECTION_SCOPE_INVALID']);
const MAPPING_REASONS = Object.freeze(['product_mapping_unverified','pos_product_missing','verified_mapping_evidence_conflict',
  'physical_stock_rule_required','verified_base_unit_missing','sale_unit_pos_mismatch','sale_quantity_rule_unverified',
  'sale_quantity_evidence_conflict','sale_unit_evidence_missing','title_pack_requires_evidence','pos_unit_label_missing',
  'pos_base_unit_factor_unverified','pos_stock_factor_unverified','shared_stock_conversion_unverified',
  'source_identifier_conflict','source_barcode_unverified','identity_rule_revoked','identity_rule_source_drift','identity_rule_unit_conflict']);
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
  if (new Set(['PROCESSING_TIMEOUT','PROCESSING_LOCK_BUSY','PROCESSING_SERVICE_UNAVAILABLE','PROCESSING_PENDING',
    'LEDGER_BUSY_OR_TIMEOUT','LEDGER_SERVICE_UNAVAILABLE']).has(reason)) return 'temporary';
  const normalized=String(reason||'').toLowerCase();
  if (/unit|quantity|pack|factor/.test(normalized)) return 'unit';
  if (/cancel|dispatch|return|legacy|confirmation|time|clock|order-items/.test(normalized)) return 'lifecycle';
  return 'identity';
}
module.exports = { RETRY_DELAYS_MS, MAPPING_REASONS, classifyRecoveryFailure, nextRecovery, classifyReviewReason };
