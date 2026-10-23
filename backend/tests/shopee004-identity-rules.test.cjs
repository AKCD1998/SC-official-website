'use strict';
const { validateIdentityRule, resolveIdentityRule, createIdentityRuleMatcher, appendIdentityRule,
  revokeIdentityRule, latestIdentityRules } = require('../src/modules/seamless/services/shopee004IdentityRules');

const clone = value => JSON.parse(JSON.stringify(value));
function fixture({ bundle = false, shared = false } = {}) {
  const components = [{ productCode: 'POS-A', quantityPerSale: 1, unit: 'กล่อง' },
    ...(bundle ? [{ productCode: 'POS-B', quantityPerSale: 2, unit: 'ขวด' }] : [])];
  const aliases = [{ productName: 'Exact boxed product', variantName: 'one box, two contents', evidenceRefs: ['seller:v1'] }];
  const rule = { schemaVersion: 'shopee004-identity-rule-v1', shopCode: 'sc-drug-store', branchCode: '004',
    ruleId: 'rule-one', version: 1, state: 'active', listingId: 'listing-1', variationId: 'variant-1', sourceSkus: ['SELLER-A'],
    aliases, components, evidenceRefs: ['seller:v1', 'unit:v1', 'pos:A', ...(bundle ? ['pos:B'] : [])], createdAt: '2026-10-23T10:00:00Z' };
  const common = { verified: true, observedAt: '2026-10-23T09:00:00Z', shopCode: rule.shopCode,
    branchCode: rule.branchCode, listingId: rule.listingId, variationId: rule.variationId };
  const posCatalog = new Map(components.map(c => [c.productCode, { companySku: c.productCode, active: true,
    smallUnit: c.unit, stockCode: shared ? 'POS-MASTER' : c.productCode, stockFactor: 1, smallFactor: 1,
    ...(shared ? { masterStockCode: 'POS-MASTER', masterActive: true, masterStockFactor: 1, masterSmallFactor: 1 } : {}) }]));
  const evidenceRefs = new Map([['seller:v1', { ...common, kind: 'seller_catalog', catalogVersion: 'catalog-v1',
    sourceSkus: ['SELLER-A'], aliases: clone(aliases) }], ['unit:v1', { ...common, kind: 'seller_description', components: clone(components), aliases: clone(aliases) }],
  ...components.map((c, i) => [`pos:${i ? 'B' : 'A'}`, { ...common, kind: 'pos_unit', productCode: c.productCode,
    unit: c.unit, stockCode: posCatalog.get(c.productCode).stockCode, stockFactor: 1, smallFactor: 1,
    ...(shared ? { masterStockCode: 'POS-MASTER', masterActive: true, masterStockFactor: 1, masterSmallFactor: 1 } : {}) }])]);
  const item = { name: aliases[0].productName, variant: aliases[0].variantName,
    listingProductId: rule.listingId, listingVariationId: rule.variationId, sourceSku: 'SELLER-A', quantity: 2 };
  return { rule, posCatalog, evidenceRefs, item };
}

test('listing/variation plus independent pack and POS evidence approves one whole box, not its two contents', () => {
  const f = fixture();
  expect(validateIdentityRule(f.rule, f)).toEqual({ valid: true, reasonCode: null });
  expect(resolveIdentityRule(f)).toMatchObject({ status: 'matched', companySku: 'POS-A', quantityPerSale: 1,
    quantityUnit: 'กล่อง', identityRuleVersion: 1 });
});

test('IDs are primary and contradictory or partial supplied IDs cannot fall back to the name', () => {
  const f = fixture(), match = createIdentityRuleMatcher({ ...f, rules: [f.rule] });
  for (const extra of [{ productId: 'different' }, { listingVariationId: 'different' },
    { listingProductId: 'different', listingVariationId: 'different' }]) {
    expect(match('sc-drug-store', { ...f.item, ...extra }).reasonCode).toBe('source_identifier_conflict');
  }
  expect(match('sc-drug-store', { name: f.item.name, variant: f.item.variant, variationId: 'variant-1' }).reasonCode).toBe('source_identifier_conflict');
});

test('emails without authoritative IDs use only independently evidenced exact aliases', () => {
  const f = fixture(), match = createIdentityRuleMatcher({ ...f, rules: [f.rule] });
  expect(match('sc-drug-store', { name: f.item.name, variant: f.item.variant }).status).toBe('matched');
  expect(match('sc-drug-store', { name: 'Exact box product', variant: f.item.variant })).toBeNull();
  expect(match('other-shop', f.item)).toBeNull();
});

test('a changed title or pack remains review until that exact alias has new verified evidence', () => {
  const f = fixture();
  const changed = { ...f.item, name: 'Renamed package', variant: 'new pack of 12' };
  expect(resolveIdentityRule({ ...f, item: changed }).reasonCode).toBe('identity_rule_source_drift');
  f.rule.aliases.push({ productName: changed.name, variantName: changed.variant, evidenceRefs: ['seller:v2'] });
  f.rule.evidenceRefs.push('seller:v2');
  f.evidenceRefs.set('seller:v2', { ...f.evidenceRefs.get('seller:v1'), catalogVersion: 'catalog-v2',
    aliases: [{ productName: changed.name, variantName: changed.variant }] });
  expect(resolveIdentityRule({ ...f, item: changed }).reasonCode).toBe('identity_rule_quantity_unverified');
  f.evidenceRefs.get('unit:v1').aliases.push({ productName: changed.name, variantName: changed.variant });
  expect(resolveIdentityRule({ ...f, item: changed }).status).toBe('matched');
  // This fixture deliberately keeps the reviewed whole-box unit unchanged. The
  // changed label alone never supplies a new factor of twelve.
  expect(resolveIdentityRule({ ...f, item: changed }).quantityPerSale).toBe(1);
});

test.each(['sourceSku', 'variantSku'])('source %s must agree even if the title and IDs match', field => {
  const f = fixture();
  expect(resolveIdentityRule({ ...f, item: { ...f.item, [field]: 'WRONG' } }).reasonCode).toBe('source_identifier_conflict');
});

test.each(['barcode', 'sourceBarcode'])('unreviewed %s never creates authority', field => {
  const f = fixture();
  expect(resolveIdentityRule({ ...f, item: { ...f.item, [field]: 'unknown' } }).reasonCode).toBe('source_barcode_unverified');
});

test('bundles retain each independently reviewed component and unit', () => {
  const f = fixture({ bundle: true }), match = createIdentityRuleMatcher({ ...f, rules: [f.rule] });
  expect(match('sc-drug-store', f.item)).toMatchObject({ status: 'bundle', components: [
    { companySku: 'POS-A', quantityPerSale: 1 }, { companySku: 'POS-B', quantityPerSale: 2 }] });
  expect(match.baseUnit('sc-drug-store', 'POS-A')).toEqual({ quantityUnit: 'กล่อง' });
  expect(match.baseUnit('sc-drug-store', 'POS-B')).toEqual({ quantityUnit: 'ขวด' });
  expect(match.baseUnit('other-shop', 'POS-A')).toBeNull();
});

test('shared stock keeps the evidenced alias identity; downstream POS conversion remains separate', () => {
  const f = fixture({ shared: true });
  expect(resolveIdentityRule(f)).toMatchObject({ status: 'matched', companySku: 'POS-A' });
  f.posCatalog.get('POS-A').stockCode = 'WRONG-MASTER';
  expect(resolveIdentityRule(f).reasonCode).toBe('shared_stock_conversion_unverified');
});

test.each(['alias-one', 'alias-two', 'alias-three', 'alias-four'])('shared stock %s requires the unchanged supported master contract', alias => {
  const f = fixture({ shared: true }), p = f.posCatalog.get('POS-A');
  p.companySku = alias;
  expect(resolveIdentityRule(f).status).toBe('matched');
  for (const changed of [{ masterActive: false }, { masterStockCode: 'wrong' }, { masterStockFactor: 2 }, { masterSmallFactor: 2 }]) {
    expect(resolveIdentityRule({ ...f, posCatalog: new Map([['POS-A', { ...p, ...changed }]]) }).reasonCode).toBe('shared_stock_conversion_unverified');
  }
  const proof = f.evidenceRefs.get('pos:A'); proof.masterActive = false;
  expect(resolveIdentityRule(f).reasonCode).toBe('identity_rule_pos_contract_unverified');
});

test.each([{ stockFactor: 2 }, { smallFactor: 2 }, { stockFactor: 0.5 }, { smallFactor: Infinity }])('unsupported POS conversion cannot be made valid merely by copying it into evidence', changed => {
  const f = fixture(); Object.assign(f.posCatalog.get('POS-A'), changed); Object.assign(f.evidenceRefs.get('pos:A'), changed);
  expect(resolveIdentityRule(f).reasonCode).toBe('identity_rule_pos_contract_invalid');
});

test.each(['missing-map', 'unverified', 'wrong-listing', 'no-unit-proof', 'wrong-factor', 'no-alias-proof'])('evidence guard: %s', condition => {
  const f = fixture();
  if (condition === 'missing-map') f.evidenceRefs = undefined;
  if (condition === 'unverified') f.evidenceRefs.get('seller:v1').verified = false;
  if (condition === 'wrong-listing') f.evidenceRefs.get('seller:v1').listingId = 'different';
  if (condition === 'no-unit-proof') f.evidenceRefs.get('unit:v1').kind = 'similarity_proposal';
  if (condition === 'wrong-factor') f.evidenceRefs.get('unit:v1').components[0].quantityPerSale = 12;
  if (condition === 'no-alias-proof') f.evidenceRefs.get('seller:v1').aliases = [];
  expect(validateIdentityRule(f.rule, f).valid).toBe(false);
});

test('unit evidence cannot be approved from an SKU, title, alias or fuzzy candidate alone', () => {
  const f = fixture();
  f.rule.evidenceRefs = ['seller:v1', 'pos:A'];
  expect(validateIdentityRule(f.rule, f).reasonCode).toBe('identity_rule_quantity_unverified');
});

test.each(['missing', 'inactive', 'unit', 'factor', 'stockCode'])('POS metadata guard: %s', condition => {
  const f = fixture(), p = f.posCatalog.get('POS-A');
  if (condition === 'missing') f.posCatalog.delete('POS-A');
  if (condition === 'inactive') p.active = false;
  if (condition === 'unit') p.smallUnit = 'tablet';
  if (condition === 'factor') p.smallFactor = 0;
  if (condition === 'stockCode') p.stockCode = '';
  expect(validateIdentityRule(f.rule, f).valid).toBe(false);
});

test('a matcher snapshot is independent from later input mutation', () => {
  const f = fixture(), match = createIdentityRuleMatcher({ ...f, rules: [f.rule] }), item = clone(f.item);
  f.rule.ruleId = 'changed'; f.rule.components[0].quantityPerSale = 100;
  f.evidenceRefs.get('seller:v1').verified = false; f.posCatalog.get('POS-A').smallUnit = 'tablet';
  expect(match('sc-drug-store', item)).toMatchObject({ status: 'matched', quantityPerSale: 1 });
});

test('ambiguous exact aliases or stable identities fail closed even if components coincide', () => {
  const f = fixture(), second = { ...clone(f.rule), ruleId: 'rule-two' };
  expect(createIdentityRuleMatcher({ ...f, rules: [f.rule, second] })('sc-drug-store', f.item).reasonCode).toBe('identity_rule_conflict');
  second.listingId = 'another-listing'; second.variationId = 'another-variation';
  expect(createIdentityRuleMatcher({ ...f, rules: [f.rule, second] })('sc-drug-store', {
    name: f.item.name, variant: f.item.variant }).reasonCode).toBe('identity_rule_conflict');
});

test('append requires optimistic version and immutable identity; no input history is changed', () => {
  const f = fixture(), versions = [];
  const added = appendIdentityRule({ ...f, rule: f.rule, versions, expectedVersion: 0 });
  expect(added.version).toBe(1); expect(versions).toEqual([]);
  expect(() => appendIdentityRule({ ...f, rule: f.rule, versions: [f.rule], expectedVersion: 0 })).toThrow('IDENTITY_RULE_REVISION_CONFLICT');
  const next = { ...clone(f.rule), version: 2, listingId: 'different' };
  expect(() => appendIdentityRule({ ...f, rule: next, versions: [f.rule], expectedVersion: 1 })).toThrow('IDENTITY_RULE_IDENTITY_IMMUTABLE');
});

test('revocation appends a version and fences old exact aliases without releasing any hold', () => {
  const f = fixture(), revoked = revokeIdentityRule({ versions: [f.rule], ruleId: f.rule.ruleId,
    expectedVersion: 1, reason: 'unit_evidence_changed', createdAt: '2026-10-23T10:01:00Z' });
  expect(f.rule.state).toBe('active'); expect(revoked.rule).toMatchObject({ version: 2, state: 'revoked' });
  expect(createIdentityRuleMatcher({ ...f, rules: [f.rule, revoked.rule] })('sc-drug-store', f.item).reasonCode).toBe('identity_rule_revoked');
  expect(revoked).not.toHaveProperty('releasedQuantity'); expect(revoked).not.toHaveProperty('cutoverAt');
});

test('same version with contradictory contents is never silently last-write-wins', () => {
  const f = fixture(), conflicting = clone(f.rule); conflicting.components[0].quantityPerSale = 9;
  expect(() => latestIdentityRules([f.rule, conflicting])).toThrow('IDENTITY_RULE_VERSION_CONFLICT');
});

test('mapping approval carries no cancellation, dispatch, return or opening approval', () => {
  const f = fixture(), result = resolveIdentityRule({ ...f, item: { ...f.item, productMatch: { quantityPerSale: 99 },
    dispatchApproved: true, lifecycleReview: 'cancel-before-dispatch' } });
  for (const name of ['lifecycleReview', 'dispatchApproved', 'openingPlan', 'cutoverAt', 'releaseQuantity']) expect(result).not.toHaveProperty(name);
  expect(result.quantityPerSale).toBe(1);
});
