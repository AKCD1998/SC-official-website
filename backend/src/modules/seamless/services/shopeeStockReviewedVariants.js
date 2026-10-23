// Stock-only evidence: never broaden the email importer or accounting copy rules.
const reviewed = require('../data/shopeeStockReviewedVariants.v1.json');
const normalize = value => String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const key = (name, variant) => JSON.stringify([normalize(name), normalize(variant)]);
const variants = new Map(), units = new Map();
for (const rule of reviewed.rules) {
  const identity = key(rule.productName, rule.variant);
  if (rule.shopCode !== 'sc-drug-store' || rule.branchCode !== '004' || !normalize(rule.productName)
    || variants.has(identity) || !rule.evidence || !Array.isArray(rule.components) || !rule.components.length
    || rule.components.some(c => !c.companySku || !c.quantityUnit || !c.posProductName
      || !Number.isSafeInteger(c.quantityPerSale) || c.quantityPerSale < 1 || c.quantityPerSale > 1000)
    || new Set(rule.components.map(c => c.companySku)).size !== rule.components.length) {
    throw new Error('STOCK_VARIANT_EVIDENCE_INVALID');
  }
  for (const c of rule.components) {
    if (units.has(c.companySku) && normalize(units.get(c.companySku)) !== normalize(c.quantityUnit)) {
      throw new Error('STOCK_VARIANT_UNIT_CONFLICT');
    }
    units.set(c.companySku, c.quantityUnit);
  }
  variants.set(identity, rule);
}

function getReviewedStockBaseUnit(shop, sku) {
  const quantityUnit = shop === 'sc-drug-store' ? units.get(sku) : undefined;
  return quantityUnit ? { quantityUnit } : null;
}

function resolveReviewedStockVariant(shop, item, { master, normalizeUnit } = {}) {
  if (shop !== 'sc-drug-store') return null;
  const rule = variants.get(key(item?.name, item?.variant));
  if (!rule) return null;
  const blocked = reasonCode => ({ status: 'unmapped', reasonCode });
  // An email has no authoritative IDs. When IDs are supplied, require both and
  // an independently anchored pair; do not silently discard contradictory data.
  const products = [item.productId, item.listingProductId].filter(v => v != null && String(v).trim()).map(String);
  const variations = [item.variationId, item.listingVariationId].filter(v => v != null && String(v).trim()).map(String);
  if ((products.length || variations.length) && (!rule.listingProductId || !rule.listingVariationId
    || !products.length || !variations.length || products.some(v => v !== rule.listingProductId)
    || variations.some(v => v !== rule.listingVariationId))) return blocked('source_identifier_conflict');
  if (item.barcode || item.sourceBarcode) return blocked('source_barcode_unverified');
  const skus = [item.variantSku, item.sourceSku].filter(v => v != null && String(v).trim()).map(v => String(v).trim());
  if (skus.length && (rule.components.length !== 1 || skus.some(v => v !== rule.components[0].companySku))) {
    return blocked('source_identifier_conflict');
  }
  if (rule.components.some(c => master?.(c.companySku)?.unit
    && normalizeUnit(master(c.companySku).unit) !== normalizeUnit(c.quantityUnit))) {
    return blocked('verified_mapping_evidence_conflict');
  }
  const common = { quantityRuleStatus: 'verified', quantityEvidence: 'reviewed_seller_export_and_pos_unit',
    matchSource: 'reviewed_exact_stock_variant', sourceLabelMismatch: rule.sourceLabelMismatch === true };
  if (rule.components.length > 1) return { ...common, status: 'bundle',
    components: rule.components.map(c => ({ companySku: c.companySku, quantityPerSale: c.quantityPerSale })) };
  const c = rule.components[0];
  return { ...common, status: 'matched', companySku: c.companySku, quantityPerSale: c.quantityPerSale,
    quantityUnit: c.quantityUnit };
}
module.exports = { resolveReviewedStockVariant, getReviewedStockBaseUnit };
