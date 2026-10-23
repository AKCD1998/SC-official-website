'use strict';
const { createLegacyEvidenceGuard } = require('../src/modules/seamless/services/shopee004LegacyEvidenceGuard');
function fixture() {
  const scope = { verified: true, shopCode: 'sc-drug-store', branchCode: '004', listingId: 'listing-1', variationId: 'variation-1', observedAt: '2026-10-23T10:00:00Z' };
  const item = { name: 'Exact product', variant: 'one box' }, alias = { productName: item.name, variantName: item.variant };
  const posCatalog = new Map([['POS-A', { companySku: 'POS-A', active: true, stockCode: 'POS-A', smallUnit: 'กล่อง', stockFactor: 1, smallFactor: 1 }]]);
  const evidenceRefs = new Map([['catalog', { ...scope, kind: 'seller_catalog', catalogVersion: 'v1', sourceSkus: ['POS-A'], aliases: [alias] }]]);
  const legacy = { status: 'matched', companySku: 'POS-A', quantityPerSale: 1, quantityUnit: 'กล่อง', quantityRuleStatus: 'verified' };
  const proof = { ...scope, kind: 'owner_unit', components: [{ productCode: 'POS-A', quantityPerSale: 1, unit: 'กล่อง' }], aliases: [alias] };
  return { scope, item, alias, posCatalog, evidenceRefs, legacy, proof,
    run: () => createLegacyEvidenceGuard({ evidenceRefs, posCatalog })('sc-drug-store', item, legacy) };
}

test('compatible trusted catalog and quantity proof preserve the exact legacy result', () => {
  const f = fixture(); f.evidenceRefs.set('unit', f.proof);
  expect(f.run()).toBe(f.legacy);
});

test('a raw catalog description without a quantity contract does not block good POS data', () => {
  const f = fixture(); f.evidenceRefs.set('description', { ...f.scope, kind: 'seller_description', text: 'A box may have two contents', aliases: [f.alias] });
  expect(f.run()).toBe(f.legacy);
});

test('independently verified conflicting quantity fences an old one-box rule', () => {
  const f = fixture(); f.proof.components[0].quantityPerSale = 2; f.evidenceRefs.set('unit', f.proof);
  expect(f.run()).toEqual({ status: 'unmapped', reasonCode: 'verified_mapping_evidence_conflict' });
});

test('a currently contradictory seller SKU needs independent exact quantity authority', () => {
  const f = fixture(); f.evidenceRefs.get('catalog').sourceSkus = ['SELLER-ALIAS'];
  expect(f.run().status).toBe('unmapped');
  f.evidenceRefs.set('unit', f.proof); expect(f.run()).toBe(f.legacy);
});

test.each([{ stockCode: 'WRONG-MASTER' }, { unit: 'เม็ด' }, { smallFactor: 2 }])('new observed POS contract drift fences only the component: %j', changed => {
  const f = fixture(); f.evidenceRefs.set('pos', { ...f.scope, kind: 'pos_unit', productCode: 'POS-A',
    stockCode: 'POS-A', unit: 'กล่อง', stockFactor: 1, smallFactor: 1, ...changed });
  expect(f.run().status).toBe('unmapped');
});

test('unverified facts, foreign scopes and raw reference strings are never authority', () => {
  const f = fixture(); f.evidenceRefs.set('untrusted', { ...f.proof, verified: false, components: [{ productCode: 'POS-A', quantityPerSale: 500, unit: 'กล่อง' }] });
  f.evidenceRefs.set('foreign', { ...f.proof, shopCode: 'other-shop', components: [{ productCode: 'POS-A', quantityPerSale: 500, unit: 'กล่อง' }] });
  f.evidenceRefs.set('raw', 'caller-supplied-reference'); expect(f.run()).toBe(f.legacy);
});

test('exact supplied IDs can anchor renamed items but contradictory known IDs cannot fall through', () => {
  const f = fixture(); f.proof.components[0].quantityPerSale = 2; f.evidenceRefs.set('unit', f.proof);
  f.item.name = 'Renamed item'; f.item.listingProductId = 'listing-1'; f.item.listingVariationId = 'variation-1';
  expect(f.run().status).toBe('unmapped');
  f.item.name = 'Exact product'; f.item.listingProductId = 'wrong';
  expect(f.run().status).toBe('unmapped');
});

test('shared aliases with independently proven identical canonical quantities do not conflict', () => {
  const f = fixture();
  f.posCatalog.set('POS-B', { companySku: 'POS-B', active: true, stockCode: 'POS-A', smallUnit: 'กล่อง', stockFactor: 1, smallFactor: 1,
    masterStockCode: 'POS-A', masterActive: true, masterStockFactor: 1, masterSmallFactor: 1 });
  f.evidenceRefs.get('catalog').sourceSkus = ['POS-B'];
  f.proof.components[0].productCode = 'POS-B'; f.evidenceRefs.set('unit', f.proof);
  expect(f.run()).toBe(f.legacy);
});

test('verified stable IDs disambiguate repeated exact titles across separate listings', () => {
  const f = fixture(); f.evidenceRefs.set('catalog-other', { ...f.evidenceRefs.get('catalog'), listingId: 'listing-2', variationId: 'variation-2' });
  expect(f.run().status).toBe('unmapped');
  f.item.listingProductId = 'listing-1'; f.item.listingVariationId = 'variation-1';
  expect(f.run()).toBe(f.legacy);
});

test('a matching observation refresh is harmless; newer conflicting proof supersedes older evidence', () => {
  const f = fixture(); f.evidenceRefs.set('pos', { ...f.scope, kind: 'pos_unit', productCode: 'POS-A', stockCode: 'POS-A', unit: 'กล่อง', stockFactor: 1, smallFactor: 1 });
  expect(f.run()).toBe(f.legacy);
  f.evidenceRefs.set('old-unit', f.proof);
  f.evidenceRefs.set('new-unit', { ...f.proof, observedAt: '2026-10-23T10:01:00Z', components: [{ productCode: 'POS-A', quantityPerSale: 2, unit: 'กล่อง' }] });
  expect(f.run().status).toBe('unmapped');
});

test('an unrelated item or an already blocked legacy match is left unchanged', () => {
  const f = fixture(), guard = createLegacyEvidenceGuard(f), blocked = { status: 'unmapped', reasonCode: 'existing_reason' };
  expect(guard('sc-drug-store', f.item, blocked)).toBe(blocked);
  expect(guard('other-shop', f.item, f.legacy)).toBe(f.legacy);
});
