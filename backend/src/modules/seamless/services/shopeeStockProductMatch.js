const { matchShopeeProduct } = require('./shopeeProductMatcher');
const { resolveVerifiedCopyMatch, sourceIdentifierConflict } = require('./shopeeVerifiedCopyMatcher');
const copyRules = require('../data/shopeeAdaSmartCopyRules.v1.json');
const { resolveCatalogQuantity, buildSingleCatalogUnitAnchors, buildReviewedCatalogUnitFactors } = require('./shopeeStockQuantityEvidence');
const listingCatalog = require('../data/shopeeProductCatalog.v1.json');
const masters = new Map(copyRules.masters.map(m => [m.companySku, m]));
const UNITS = new Map([
  ['กล่อง', 'box'], ['bx', 'box'], ['boxes', 'box'], ['pcs', 'piece'], ['pc', 'piece'], ['ซอง', 'sachet'],
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
  rules = copyRules.rules, unitEquivalences = copyRules.unitEquivalences, unitReviews = copyRules.unitReviews,
  posCatalog,
} = {}) {
  const exact = match(shop, item);
  const productIds = [item.productId, item.listingProductId].filter(v => v != null && String(v).trim()).map(String);
  const variationIds = [item.variationId, item.listingVariationId].filter(v => v != null && String(v).trim()).map(String);
  if ((productIds.length || variationIds.length) && (exact.status !== 'matched' || !productIds.length || !variationIds.length
    || productIds.some(v => v !== exact.listingProductId) || variationIds.some(v => v !== exact.listingVariationId))) {
    return { status: 'unmapped', reasonCode: 'source_identifier_conflict' };
  }
  // Explicit reviewed identity/pack corrections have the same precedence as the
  // existing copy workflow. Financial consolidation is not physical stock evidence.
  const override = rules.find(r => r.shopCode === shop && r.productName === item.name && r.variant === (item.variant || ''));
  if (override) {
    if (/accounting/i.test(override.authority || '')) return { status: 'unmapped', reasonCode: 'physical_stock_rule_required' };
    if (override.components) {
      const components = override.components.map(c => ({ companySku: c.companySku,
        quantityPerSale: c.quantityPerSale }));
      if (!components.length || components.some(c => !master(c.companySku)?.unit
        || !Number.isSafeInteger(c.quantityPerSale) || c.quantityPerSale <= 0)) {
        return { status: 'unmapped', reasonCode: 'physical_stock_rule_required' };
      }
      return { status: 'bundle', quantityRuleStatus: 'verified', components,
        quantityEvidence: 'existing_reviewed_physical_components' };
    }
    if (!master(override.companySku)?.unit || !Number.isSafeInteger(override.quantityPerSale) || override.quantityPerSale < 1
      || identifierConflict(shop, item, override)) return { status: 'unmapped', reasonCode: 'source_identifier_conflict' };
    return { status: 'matched', companySku: override.companySku, quantityPerSale: override.quantityPerSale,
      quantityUnit: master(override.companySku).unit, quantityRuleStatus: 'verified',
      quantityEvidence: 'existing_reviewed_exact_override', matchSource: 'existing_reviewed_exact_override' };
  }
  const verified = copy(shop, item);
  if (verified.status === 'review' && verified.reasonCode === 'automatic_evidence_conflict') {
    return { status: 'unmapped', reasonCode: 'verified_mapping_evidence_conflict' };
  }
  if (verified.status !== 'matched' && (item.barcode || item.sourceBarcode)) {
    return { status: 'unmapped', reasonCode: 'source_barcode_unverified' };
  }
  if (verified.status === 'matched' && /accounting/i.test(verified.rule.authority || '')) {
    return { status: 'unmapped', reasonCode: 'physical_stock_rule_required' };
  }
  if (exact.status === 'matched') {
    const catalogUnitAnchors = buildSingleCatalogUnitAnchors(listingCatalog.records, {
      master, unitReviews, rules, posCatalog, normalizeUnit: normalizeStockUnit });
    const reviewedUnitFactors = buildReviewedCatalogUnitFactors(listingCatalog.records, {
      master, rules, unitReviews, normalizeUnit: normalizeStockUnit });
    const evidence = resolveCatalogQuantity({ item, match: exact, master: master(exact.companySku),
      posProduct: posCatalog?.get(exact.companySku), shopCode: shop, catalogUnitAnchors,
      unitEquivalences, unitReviews, reviewedUnitFactors, normalizeUnit: normalizeStockUnit });
    if (!evidence.reason) {
      if (evidence.quantityEvidence === 'approved_catalog_single_base_unit' && verified.status === 'matched'
        && exact.companySku === verified.rule.companySku && Number.isSafeInteger(verified.rule.quantityPerSale)
        && verified.rule.quantityPerSale > 0 && !identifierConflict(shop, item, verified.rule)) {
        return { ...exact, quantityPerSale: verified.rule.quantityPerSale, quantityUnit: master(exact.companySku).unit,
          quantityRuleStatus: 'verified', quantityEvidence: 'existing_reviewed_copy_pack',
          matchSource: 'existing_verified_copy_and_pos_unit_audit' };
      }
      const strongerContent = evidence.quantityEvidence?.startsWith('pos_and_erp_')
        && verified.status === 'matched' && verified.rule.authority === 'existing_verified_catalog';
      if (verified.status === 'matched' && (exact.companySku !== verified.rule.companySku
        || (evidence.quantityPerSale !== verified.rule.quantityPerSale && !strongerContent))) {
        return { status: 'unmapped', reasonCode: 'verified_mapping_evidence_conflict' };
      }
      if (identifierConflict(shop, item, { companySku: exact.companySku, ...evidence })) {
        return { status: 'unmapped', reasonCode: 'source_identifier_conflict' };
      }
      return { ...exact, ...evidence, quantityRuleStatus: 'verified', matchSource: 'approved_catalog_and_erp_base_unit' };
    }
    // Keep explicit holds even if a structural matcher can produce a convenient factor.
    return { status: 'unmapped', reasonCode: evidence.reason };
  }
  if (verified.status !== 'matched') {
    if (verified.reasonCode === 'automatic_evidence_conflict'
      || (verified.reasonCode === 'automatic_bundle_or_special_authority_hold' && exact.status === 'matched')) {
      return { status: 'unmapped', reasonCode: 'verified_mapping_evidence_conflict' };
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

function getStockBaseUnit(_shop, sku) { const m = masters.get(sku); return m?.unit ? { quantityUnit: m.unit } : null; }
module.exports = { resolveStockProductMatch, normalizeStockUnit, getStockBaseUnit };
