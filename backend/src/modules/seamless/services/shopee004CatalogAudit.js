'use strict';

const { createIdentityRuleMatcher, normalizeIdentityText: norm, latestIdentityRules } = require('./shopee004IdentityRules');
const { resolveStockProductMatch } = require('./shopeeStockProductMatch');
const count = (m, key) => { m[key] = (m[key] || 0) + 1; };
const text = v => typeof v === 'string' ? v.trim() : '';
const identity = r => JSON.stringify([r.listingId, r.variationId]);
const sameAlias = (a, b) => norm(a.productName) === norm(b.productName) && norm(a.variantName) === norm(b.variantName);
const componentsOf = m => m?.status === 'matched' ? [{ productCode: m.companySku,
  quantityPerSale: m.quantityPerSale, unit: m.quantityUnit }]
  : m?.status === 'bundle' ? (m.components || []).map(c => ({ productCode: c.companySku, quantityPerSale: c.quantityPerSale })) : [];

// Catalog-only preaudit; never processes an order or changes a reservation.
// Private records may contain product identifiers. Publish aggregate, not records.
function auditStoreCatalog({ records = [], expectedListings, expectedVariations, catalogVersion, observedAt,
  rules = [], evidenceRefs, posCatalog, proposeCandidates, legacyMatcher = resolveStockProductMatch } = {}) {
  if (!Array.isArray(records) || records.length > 10000 || !Number.isFinite(Date.parse(observedAt))
    || !text(catalogVersion) || !(posCatalog instanceof Map)) throw new Error('CATALOG_AUDIT_INPUT_INVALID');
  const matcher = createIdentityRuleMatcher({ rules, evidenceRefs, posCatalog }), ids = new Map(), listings = new Set(), reasons = {};
  const result = [], duplicateConflicts = new Set();
  for (const r of records) {
    if (!r || !text(r.listingId) || !text(r.variationId) || !text(r.productName)
      || typeof r.variantName !== 'string' || typeof r.sourceSku !== 'string') throw new Error('CATALOG_RECORD_INVALID');
    listings.add(r.listingId);
    const k = identity(r);
    if (ids.has(k) && JSON.stringify(ids.get(k)) !== JSON.stringify(r)) duplicateConflicts.add(k);
    else ids.set(k, r);
  }
  for (const r of ids.values()) {
    const item = { name: r.productName, variant: r.variantName, listingProductId: r.listingId,
      listingVariationId: r.variationId, ...(r.sourceSku ? { sourceSku: r.sourceSku } : {}) };
    let exact = duplicateConflicts.has(identity(r)) ? { status: 'unmapped', reasonCode: 'catalog_duplicate_conflict' }
      : matcher('sc-drug-store', item, { posCatalog });
    let legacy = null;
    // Existing email-only reviewed rules remain useful evidence to propose a new
    // stable-ID binding. They do not authorize that binding during this audit.
    if (!exact) legacy = legacyMatcher('sc-drug-store', { name: r.productName, variant: r.variantName,
      ...(r.sourceSku ? { sourceSku: r.sourceSku } : {}) }, { posCatalog });
    const components = componentsOf(exact || legacy);
    const metadataMissing = components.some(c => !posCatalog.has(c.productCode));
    // A versioned rule may legitimately anchor a seller-owned SKU to a different
    // POS code. Only an unanchored legacy proposal uses the equality shortcut.
    const skuConflict = !exact && r.sourceSku && components.length === 1 && r.sourceSku !== components[0].productCode;
    let reasonCode = exact?.reasonCode || null;
    let status = exact && ['matched', 'bundle'].includes(exact.status) ? 'verified' : 'review_required';
    if (!exact) {
      reasonCode = metadataMissing ? 'pos_product_missing' : skuConflict ? 'source_identifier_conflict'
        : legacy && ['matched', 'bundle'].includes(legacy.status) && legacy.quantityRuleStatus === 'verified'
          ? 'stable_identity_binding_required' : legacy?.reasonCode || 'product_mapping_unverified';
    }
    if (metadataMissing || skuConflict) { status = 'review_required'; reasonCode = metadataMissing ? 'pos_product_missing' : 'source_identifier_conflict'; }
    const proposals = status === 'verified' ? [] : components.length && !skuConflict
      ? [{ source: 'existing_reviewed_mapping', components, approvalRequired: true }]
      : typeof proposeCandidates === 'function' ? (proposeCandidates(r) || []).slice(0, 5).map(p => ({
        source: 'similarity_proposal_only', productCode: text(p.productCode), productName: text(p.productName),
        approvalRequired: true, quantityPerSale: null, unit: null })) : [];
    count(reasons, reasonCode || 'verified');
    result.push({ listingId: r.listingId, variationId: r.variationId, productName: r.productName,
      variantName: r.variantName, sourceSku: r.sourceSku, status, reasonCode,
      ruleVersion: exact?.identityRuleVersion || null, components: status === 'verified' ? components : [],
      proposedMatches: proposals, requiresUnitEvidence: status !== 'verified', lifecycleApprovalGranted: false });
  }
  const current = latestIdentityRules(rules), removed = current.filter(r => r.state === 'active' && !ids.has(identity(r)));
  const renamed = current.filter(r => r.state === 'active' && ids.has(identity(r))
    && !r.aliases.some(a => sameAlias(a, ids.get(identity(r)))));
  const expectedKnown = Number.isSafeInteger(expectedListings) && expectedListings >= 0;
  const variationKnown = Number.isSafeInteger(expectedVariations) && expectedVariations >= 0;
  const complete = expectedKnown && expectedListings === listings.size && (!variationKnown || expectedVariations === ids.size)
    && duplicateConflicts.size === 0;
  return { schemaVersion: 'shopee004-catalog-audit-v1', observedAt, catalogVersion, records: result,
    aggregate: { shopCode: 'sc-drug-store', branchCode: '004', observedListings: listings.size,
      observedVariations: ids.size, expectedListings: expectedKnown ? expectedListings : null,
      expectedVariations: variationKnown ? expectedVariations : null, catalogCoverageComplete: complete,
      sourceRows: records.length, exactDuplicateRows: records.length - ids.size - duplicateConflicts.size,
      conflictingVariantIdentities: duplicateConflicts.size, verifiedVariations: result.filter(r => r.status === 'verified').length,
      reviewVariations: result.filter(r => r.status !== 'verified').length, reasons,
      changedNameOrPackIdentities: renamed.length, missingActiveRuleIdentities: removed.length,
      missingIdentityMeansDeleted: false, mappingRulesWritten: 0, stockWrites: 0, lifecycleApprovals: 0 },
    ruleDrift: { changed: renamed.map(r => ({ ruleId: r.ruleId, version: r.version, listingId: r.listingId, variationId: r.variationId })),
      missing: removed.map(r => ({ ruleId: r.ruleId, version: r.version, listingId: r.listingId, variationId: r.variationId })) } };
}

module.exports = { auditStoreCatalog };
