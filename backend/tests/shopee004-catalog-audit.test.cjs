'use strict';
const { auditStoreCatalog } = require('../src/modules/seamless/services/shopee004CatalogAudit');
const record = { listingId: 'listing-1', variationId: 'variant-1', productName: 'Exact product', variantName: 'box of two', sourceSku: 'POS-A' };
const options = records => ({ records, expectedListings: 1, expectedVariations: 1, catalogVersion: 'live-export-v1',
  observedAt: '2026-10-23T10:00:00Z', posCatalog: new Map([['POS-A', { active: true, smallUnit: 'กล่อง',
    stockCode: 'POS-A', stockFactor: 1, smallFactor: 1 }]]), legacyMatcher: () => ({ status: 'matched', companySku: 'POS-A',
    quantityPerSale: 1, quantityUnit: 'กล่อง', quantityRuleStatus: 'verified' }) });

test('whole-store preaudit reports coverage independently from mapping qualification', () => {
  const v = auditStoreCatalog(options([record]));
  expect(v.aggregate).toMatchObject({ catalogCoverageComplete: true, observedListings: 1, observedVariations: 1,
    verifiedVariations: 0, reviewVariations: 1, mappingRulesWritten: 0, stockWrites: 0, lifecycleApprovals: 0 });
  expect(v.records[0]).toMatchObject({ reasonCode: 'stable_identity_binding_required', components: [], requiresUnitEvidence: true,
    proposedMatches: [{ approvalRequired: true, source: 'existing_reviewed_mapping' }] });
});

test('an incomplete export is not a complete store audit or proof of deletion', () => {
  const v = auditStoreCatalog({ ...options([record]), expectedListings: 2, expectedVariations: 3 });
  expect(v.aggregate.catalogCoverageComplete).toBe(false); expect(v.aggregate.missingIdentityMeansDeleted).toBe(false);
  expect(auditStoreCatalog({ ...options([record]), expectedListings: undefined }).aggregate.catalogCoverageComplete).toBe(false);
});

test('conflicting duplicate identities are fenced, exact duplicates are counted without double coverage', () => {
  const same = auditStoreCatalog(options([record, { ...record }]));
  expect(same.aggregate).toMatchObject({ observedVariations: 1, exactDuplicateRows: 1, conflictingVariantIdentities: 0 });
  const conflict = auditStoreCatalog(options([record, { ...record, sourceSku: 'POS-B' }]));
  expect(conflict.aggregate.catalogCoverageComplete).toBe(false);
  expect(conflict.records[0].reasonCode).toBe('catalog_duplicate_conflict');
});

test('catalog SKU conflicts cannot be approved from a convenient old email match', () => {
  const v = auditStoreCatalog(options([{ ...record, sourceSku: 'WRONG' }]));
  expect(v.records[0]).toMatchObject({ reasonCode: 'source_identifier_conflict', proposedMatches: [], components: [] });
});

test('an old reviewed match with missing live POS metadata remains a review', () => {
  const v = auditStoreCatalog({ ...options([record]), posCatalog: new Map() });
  expect(v.records[0].reasonCode).toBe('pos_product_missing');
});

test('fuzzy candidates are proposals without unit or quantity approval', () => {
  const v = auditStoreCatalog({ ...options([record]), legacyMatcher: () => ({ status: 'unmapped' }),
    proposeCandidates: () => [{ productCode: 'POS-B', productName: 'Similar product', quantityPerSale: 200, unit: 'box' }] });
  expect(v.records[0].proposedMatches).toEqual([{ source: 'similarity_proposal_only', productCode: 'POS-B', productName: 'Similar product',
    approvalRequired: true, quantityPerSale: null, unit: null }]);
});

test('catalog drift of an active rule is visible without inferring deletion or changing its version', () => {
  const rule = { ruleId: 'rule-1', version: 2, state: 'active', listingId: record.listingId,
    variationId: record.variationId, aliases: [{ productName: 'Old product', variantName: record.variantName }], components: [] };
  const v = auditStoreCatalog({ ...options([record]), rules: [rule] });
  expect(v.aggregate.changedNameOrPackIdentities).toBe(1);
  expect(rule.version).toBe(2); expect(v.aggregate.mappingRulesWritten).toBe(0);
  const absent = auditStoreCatalog({ ...options([]), rules: [rule] });
  expect(absent.aggregate.missingActiveRuleIdentities).toBe(1); expect(absent.aggregate.missingIdentityMeansDeleted).toBe(false);
});

test('audit aggregate does not contain product identities, private raw rows or quantities', () => {
  const v = auditStoreCatalog(options([record]));
  expect(JSON.stringify(v.aggregate)).not.toContain(record.listingId);
  expect(JSON.stringify(v.aggregate)).not.toContain(record.productName);
  expect(v.aggregate).not.toHaveProperty('stock');
});

test('an independently anchored seller SKU may differ from the POS component code', () => {
  const f = options([{ ...record, sourceSku: 'SELLER-A' }]);
  f.posCatalog.get('POS-A').companySku = 'POS-A';
  const alias = { productName: record.productName, variantName: record.variantName, evidenceRefs: ['seller:1'] };
  const component = { productCode: 'POS-A', quantityPerSale: 1, unit: 'กล่อง' };
  const scope = { verified: true, observedAt: f.observedAt, shopCode: 'sc-drug-store', branchCode: '004',
    listingId: record.listingId, variationId: record.variationId };
  f.rules = [{ schemaVersion: 'shopee004-identity-rule-v1', shopCode: scope.shopCode, branchCode: scope.branchCode,
    ruleId: 'one', version: 1, state: 'active', listingId: record.listingId, variationId: record.variationId,
    sourceSkus: ['SELLER-A'], aliases: [alias], components: [component], evidenceRefs: ['seller:1', 'unit:1', 'pos:1'], createdAt: f.observedAt }];
  f.evidenceRefs = new Map([['seller:1', { ...scope, kind: 'seller_catalog', catalogVersion: 'v1',
    sourceSkus: ['SELLER-A'], aliases: [alias] }], ['unit:1', { ...scope, kind: 'seller_description', components: [component], aliases: [alias] }],
  ['pos:1', { ...scope, kind: 'pos_unit', productCode: 'POS-A', unit: 'กล่อง', stockCode: 'POS-A', stockFactor: 1, smallFactor: 1 }]]);
  expect(auditStoreCatalog(f).records[0]).toMatchObject({ status: 'verified', reasonCode: null });
});
