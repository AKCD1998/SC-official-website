const { matchShopeeProduct } = require('./shopeeProductMatcher');
const { resolveVerifiedCopyMatch, sourceIdentifierConflict } = require('./shopeeVerifiedCopyMatcher');
const copyRules = require('../data/shopeeAdaSmartCopyRules.v1.json');
const masters = new Map(copyRules.masters.map(m => [m.companySku, m]));
const UNITS = new Map([
  ['กล่อง', 'box'], ['bx', 'box'], ['boxes', 'box'], ['ซอง', 'sachet'],
  ['กระป๋อง', 'can'], ['กระปุก', 'jar'], ['ก้อน', 'bar'], ['ชิ้น', 'piece'],
  ['แพ็ค', 'pack'], ['แพ๊ค', 'pack'], ['แพค', 'pack'], ['แพ็ก', 'pack'], ['แผง', 'blister'],
  ['ขวด', 'bottle'], ['หลอด', 'tube'], ['เม็ด', 'tablet'], ['ถุง', 'bag'],
]);
function normalizeStockUnit(value) {
  const text = typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : '';
  return UNITS.get(text) || text;
}

// Reuse the already reviewed pack/base-unit evidence used by the quotation preview.
// Do not change that matcher, the email importer or the accounting consolidation rules.
function resolveStockProductMatch(shop, item, {
  match = matchShopeeProduct, copy = resolveVerifiedCopyMatch,
  master = sku => masters.get(sku), identifierConflict = sourceIdentifierConflict,
} = {}) {
  const exact = match(shop, item);
  const verified = copy(shop, item);
  if (verified.status !== 'matched') {
    if (verified.reasonCode === 'automatic_evidence_conflict'
      || (verified.reasonCode === 'automatic_bundle_or_special_authority_hold' && exact.status === 'matched')) {
      return { status: 'unmapped', reasonCode: 'verified_mapping_evidence_conflict' };
    }
    const ids = [item.productId, item.listingProductId].filter(v => v != null && String(v).trim()).map(String);
    const variants = [item.variationId, item.listingVariationId].filter(v => v != null && String(v).trim()).map(String);
    if ((ids.length || variants.length) && (exact.status !== 'matched' || !ids.length || !variants.length
      || ids.some(v => v !== exact.listingProductId) || variants.some(v => v !== exact.listingVariationId))) {
      return { status: 'unmapped', reasonCode: 'source_identifier_conflict' };
    }
    if (item.barcode || item.sourceBarcode) return { status: 'unmapped', reasonCode: 'source_barcode_unverified' };
    return exact;
  }
  const rule = verified.rule;
  if (identifierConflict(shop, item, rule)) return { status: 'unmapped', reasonCode: 'source_identifier_conflict' };
  if (exact.status === 'bundle' || exact.status === 'visibility_only'
    || (exact.status === 'matched' && (exact.companySku !== rule.companySku
      || (exact.quantityRuleStatus === 'verified' && exact.quantityPerSale !== rule.quantityPerSale)))) {
    return { status: 'unmapped', reasonCode: 'verified_mapping_evidence_conflict' };
  }
  const source = master(rule.companySku);
  if (!source?.unit || !Number.isSafeInteger(rule.quantityPerSale) || rule.quantityPerSale <= 0) {
    return { status: 'unmapped', reasonCode: 'verified_base_unit_missing' };
  }
  if (exact.quantityUnit && normalizeStockUnit(exact.quantityUnit) !== normalizeStockUnit(source.unit)) {
    return { status: 'unmapped', reasonCode: 'verified_mapping_evidence_conflict' };
  }
  return { status: 'matched', companySku: rule.companySku, quantityPerSale: rule.quantityPerSale,
    quantityRuleStatus: 'verified', quantityUnit: source.unit,
    matchSource: 'existing_verified_copy_and_pos_unit_audit' };
}

module.exports = { resolveStockProductMatch, normalizeStockUnit };
