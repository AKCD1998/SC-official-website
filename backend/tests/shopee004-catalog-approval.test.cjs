'use strict';
const { buildCatalogIdentityApproval } = require('../src/modules/seamless/services/shopee004CatalogApproval');
const clone = v => JSON.parse(JSON.stringify(v));
const at = '2026-10-23T10:00:00Z';
function fixture() {
  const component = { productCode: 'POS-A', quantityPerSale: 1, unit: 'กล่อง' };
  const alias = { productName: 'Whole box with two contents', variantName: 'one box' };
  const scope = { verified: true, observedAt: at, shopCode: 'sc-drug-store', branchCode: '004', listingId: 'listing-1', variationId: 'variation-1' };
  const evidenceRefs = new Map([['seller:1', { ...scope, kind: 'seller_catalog', catalogVersion: 'catalog-current', sourceSkus: ['SELLER-A'], aliases: [alias] }],
    ['unit:1', { ...scope, kind: 'reviewed_stock_rule', components: [component], aliases: [alias],
      reviewedRuleVersion: 'v1', reviewedRuleReference: 'reviewed:one', reviewAuthority: 'owner_reviewed', auditReference: 'audit:one' }],
    ['pos:1', { ...scope, kind: 'pos_unit', productCode: 'POS-A', unit: 'กล่อง', stockCode: 'POS-A', stockFactor: 1, smallFactor: 1 }]]);
  const context = { versions: [], posCatalog: new Map([['POS-A', { companySku: 'POS-A', active: true, smallUnit: 'กล่อง',
    stockCode: 'POS-A', stockFactor: 1, smallFactor: 1 }]]), evidenceRefs };
  const request = { operationId: 'ignored-by-pure-rule-builder', listingId: scope.listingId, variationId: scope.variationId,
    components: [component], evidenceRefs: ['seller:1', 'unit:1', 'pos:1'], acknowledgeUnitEvidence: true,
    expectedCatalogVersion: 'catalog-current', expectedVersion: 0 };
  return { context, request, build: () => buildCatalogIdentityApproval(context, request, { now: () => new Date(at) }) };
}

test('prepares proactive approval without an order exception or lifecycle action', () => {
  const f = fixture(), result = f.build();
  expect(result).toMatchObject({ previous: null, version: 1, rule: { sourceSkus: ['SELLER-A'], components: f.request.components, createdAt: '2026-10-23T10:00:00.000Z' } });
  expect(result.rule.ruleId).toMatch(/^[0-9a-f-]{36}$/);
  expect(f.context.versions).toHaveLength(0);
  for (const key of ['operationId', 'exceptionId', 'actor', 'cutoverAt', 'openingPlan', 'cancelApproved']) expect(result.rule).not.toHaveProperty(key);
});

test('request aliases, source SKU and lifecycle claims cannot create evidence', () => {
  const f = fixture(); Object.assign(f.request, { aliases: [{ productName: 'forged' }], sourceSkus: ['WRONG'], cancelApproved: true });
  const result = f.build();
  expect(result.rule.aliases.map(a => a.productName)).toEqual(['Whole box with two contents']);
  expect(result.rule.sourceSkus).toEqual(['SELLER-A']);
});

test.each(['acknowledgement', 'unverified-proof', 'missing-ref', 'wrong-scope', 'wrong-unit', 'wrong-quantity'])('rejects invalid or unproven approval: %s', condition => {
  const f = fixture();
  if (condition === 'acknowledgement') f.request.acknowledgeUnitEvidence = false;
  if (condition === 'unverified-proof') f.context.evidenceRefs.get('unit:1').verified = false;
  if (condition === 'missing-ref') f.request.evidenceRefs[1] = 'caller:made-up';
  if (condition === 'wrong-scope') f.context.evidenceRefs.get('unit:1').variationId = 'another';
  if (condition === 'wrong-unit') f.request.components = [{ ...f.request.components[0], unit: 'เม็ด' }];
  if (condition === 'wrong-quantity') f.request.components = [{ ...f.request.components[0], quantityPerSale: 2 }];
  expect(() => f.build()).toThrow();
});

test('a stale expected catalog version is rejected even if old compatible proof remains trusted', () => {
  const f = fixture(); f.context.evidenceRefs.set('seller:2', { ...f.context.evidenceRefs.get('seller:1'),
    observedAt: '2026-10-23T10:01:00Z', catalogVersion: 'catalog-new' });
  expect(() => f.build()).toThrow('IDENTITY_CATALOG_VERSION_CONFLICT');
  f.request.expectedCatalogVersion = 'catalog-new';
  expect(() => f.build()).toThrow('IDENTITY_CATALOG_EVIDENCE_REQUIRED');
  f.request.evidenceRefs[0] = 'seller:2'; expect(f.build().version).toBe(1);
});

test('same-time contradictory catalog payloads are not resolved by selecting a convenient version', () => {
  const f = fixture(); f.context.evidenceRefs.set('seller:2', { ...f.context.evidenceRefs.get('seller:1'),
    sourceSkus: ['WRONG'], catalogVersion: 'catalog-current' });
  expect(() => f.build()).toThrow('IDENTITY_CATALOG_EVIDENCE_CONFLICT');
});

test('existing stable identity advances only the expected rule version', () => {
  const f = fixture(), first = f.build(); f.context.versions.push(first.rule);
  expect(() => f.build()).toThrow('IDENTITY_RULE_REVISION_CONFLICT');
  f.request.expectedVersion = 1; const second = f.build();
  expect(second).toMatchObject({ version: 2, previous: first.rule, rule: { ruleId: first.rule.ruleId, version: 2 } });
  expect(first.rule.version).toBe(1);
});

test('approved historical aliases survive only when their exact reviewed quantity evidence is selected', () => {
  const f = fixture(); f.context.evidenceRefs.set('unit:old', { ...clone(f.context.evidenceRefs.get('unit:1')),
    aliases: [{ productName: 'Old exact title', variantName: 'one box' }] });
  f.request.evidenceRefs.push('unit:old');
  expect(f.build().rule.aliases).toHaveLength(2);
  f.context.evidenceRefs.get('unit:old').components[0].quantityPerSale = 12;
  expect(f.build().rule.aliases).toHaveLength(1);
});

test('an active exact alias cannot be stolen by another listing identity', () => {
  const f = fixture(), first = f.build();
  f.context.versions = [{ ...first.rule, listingId: 'other-listing', variationId: 'other-variation' }];
  expect(() => f.build()).toThrow('IDENTITY_RULE_CONFLICT');
});

test('shared and bundle component validation still comes from the strict existing rule contract', () => {
  const f = fixture(); f.context.posCatalog.get('POS-A').stockCode = 'MASTER';
  expect(() => f.build()).toThrow('SHARED_STOCK_CONVERSION_UNVERIFIED');
});
