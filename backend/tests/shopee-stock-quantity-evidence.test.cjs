const { packFacts, resolveCatalogQuantity, stockContentFrame, buildSingleCatalogUnitAnchors,
  buildReviewedCatalogUnitFactors } = require('../src/modules/seamless/services/shopeeStockQuantityEvidence');
const { normalizeStockUnit } = require('../src/modules/seamless/services/shopeeStockProductMatch');
const normalizeUnit = normalizeStockUnit;
const shopCode = 'sc-drug-store';
const master = { companySku: 'synthetic', name: 'Synthetic container', unit: 'ซอง' };
const posProduct = { companySku: 'synthetic', active: true, smallFactor: 1, stockFactor: 1, smallUnit: 'ซอง', productName: 'Synthetic container' };
const match = { status: 'matched', companySku: 'synthetic' };
function resolve(overrides = {}) {
  return resolveCatalogQuantity({ item: { name: 'Synthetic product', variant: '' }, shopCode,
    match, master, posProduct, normalizeUnit, ...overrides });
}
function record(variant, productName = 'Synthetic product') {
  return { shopCode, match, variant, productName };
}

test('the variant count takes precedence over outer contents in the product title', () => {
  const r = resolve({ item: { name: 'Synthetic 50 sachets', variant: '10 pcs' }, reviewedUnitFactors: [{
    shopCode, companySku: 'synthetic', sourceQuantityUnit: 'piece', erpUnit: 'ซอง', factor: 1 }] });
  expect(r).toMatchObject({ quantityPerSale: 10, quantityUnit: 'ซอง' });
});

test('an independently reviewed same-SKU pack translates two packs of fifty into one hundred base units', () => {
  const records = [record('1 pack'), record('3 packs')];
  const rules = records.map((r, i) => ({ ...r, companySku: 'synthetic', quantityPerSale: i ? 150 : 50,
    authority: 'verified_source_pack_and_erp_master' }));
  const factors = buildReviewedCatalogUnitFactors(records, { master: () => master, rules, normalizeUnit });
  expect(resolve({ match: { ...match, quantityRuleStatus: 'verified', quantityPerSale: 2, quantityUnit: 'pack' },
    reviewedUnitFactors: factors })).toMatchObject({ quantityPerSale: 100, quantityUnit: 'ซอง' });
});

test('different-SKU, different-shop and conflicting pack factors cannot establish a conversion', () => {
  const f = { shopCode, companySku: 'synthetic', sourceQuantityUnit: 'pack', erpUnit: 'ซอง', factor: 50 };
  const m = { ...match, quantityRuleStatus: 'verified', quantityPerSale: 2, quantityUnit: 'pack' };
  for (const reviewedUnitFactors of [[{ ...f, companySku: 'other' }], [{ ...f, shopCode: 'dr-morepen' }], [f, { ...f, factor: 20 }]]) {
    expect(resolve({ match: m, reviewedUnitFactors }).reason).toBe('sale_unit_pos_mismatch');
  }
});

test.each(['existing_verified_catalog', 'user_authorized_accounting_consolidation', 'automatic_inference'])
  ('%s is not independent physical-unit factor proof', authority => {
    const r = record('1 pack');
    expect(buildReviewedCatalogUnitFactors([r], { master: () => master, normalizeUnit,
      rules: [{ ...r, companySku: 'synthetic', quantityPerSale: 50, authority }] })).toEqual([]);
  });

test('an independent POS/ERP three-piece stock pack converts physical contents once', () => {
  const m = { ...master, unit: 'ชิ้น', name: 'Synthetic 3 pieces' };
  const p = { ...posProduct, smallUnit: 'ชิ้น', productName: 'Synthetic 3 pieces' };
  for (const [variant, expected] of [['1 box 12 pieces', 4], ['1 box 3 pieces', 1]]) {
    expect(resolve({ master: m, posProduct: p, item: { name: 'Synthetic 3 pieces', variant } }))
      .toMatchObject({ quantityPerSale: expected, quantityUnit: 'ชิ้น' });
  }
});

test.each([
  ['different ERP content', { name: 'Synthetic 6 pieces' }, {}, '1 box 12 pieces'],
  ['different POS content', {}, { productName: 'Synthetic 6 pieces' }, '1 box 12 pieces'],
  ['unsupported physical split', {}, {}, '1 box 2 pieces'],
])('%s cannot prove the stock pack conversion', (_label, erpChange, posChange, variant) => {
  const m = { ...master, unit: 'ชิ้น', name: 'Synthetic 3 pieces', ...erpChange };
  const p = { ...posProduct, smallUnit: 'ชิ้น', productName: 'Synthetic 3 pieces', ...posChange };
  expect(resolve({ master: m, posProduct: p, item: { name: 'Synthetic 3 pieces', variant } }).reason).toBeDefined();
});

test('a generic piece count equal to stock-pack contents remains unresolved without a physical-unit rule', () => {
  expect(resolve({ master: { ...master, unit: 'ชิ้น', name: 'Synthetic 2 pieces' },
    posProduct: { ...posProduct, smallUnit: 'ชิ้น', productName: 'Synthetic 2 pieces' },
    item: { name: 'Synthetic product', variant: '2 pcs' } }).reason).toBe('sale_quantity_rule_unverified');
});

test('one six-tablet source sachet independently anchors the five-sachet model to five POS blisters', () => {
  const m = { ...master, unit: 'แผง', name: 'Synthetic 6 tablets' };
  const p = { ...posProduct, smallUnit: 'แผง', productName: 'Synthetic 6 tablets' };
  const anchors = buildSingleCatalogUnitAnchors([record('', 'Synthetic 1 sachet 6 tablets')], {
    master: () => m, posCatalog: new Map([['synthetic', p]]), normalizeUnit });
  expect(resolve({ master: m, posProduct: p, catalogUnitAnchors: anchors,
    match: { ...match, quantityRuleStatus: 'verified', quantityPerSale: 5, quantityUnit: 'sachet' },
    item: { name: 'Synthetic 1 box 5 sachets', variant: '' } })).toMatchObject({ quantityPerSale: 5, quantityUnit: 'แผง' });
});

test('three source blisters of two tablets correspond to three two-tablet stock packs', () => {
  expect(resolve({ master: { ...master, name: 'Synthetic 2 tablets' },
    posProduct: { ...posProduct, productName: 'Synthetic 2 tablets' },
    item: { name: 'Synthetic 1 blister 2 tablets', variant: '3 blisters' } })).toMatchObject({ quantityPerSale: 3 });
});

test('explicit unit review holds cannot be bypassed by convenient pack contents', () => {
  expect(resolve({ master: { ...master, name: 'Synthetic 2 tablets' },
    posProduct: { ...posProduct, productName: 'Synthetic 2 tablets' },
    item: { name: 'Synthetic 1 blister 2 tablets', variant: '3 blisters' },
    unitReviews: [{ companySku: 'synthetic', variant: '3 blisters' }] }).reason).toBe('sale_quantity_rule_unverified');
});

test.each(['1.5 boxes', '1,5 packs', '1/2 sachet', '0 boxes', '-2 packs'])('%s is not silently truncated to a positive integer', variant => {
  expect(packFacts(variant, normalizeUnit).invalid).toBe(true);
  expect(resolve({ item: { name: 'Synthetic', variant }, match: { ...match,
    quantityRuleStatus: 'verified', quantityPerSale: 5, quantityUnit: 'sachet' } }).reason).toBeDefined();
});

test('an actual non-generic POS container count can be read from a reviewed title, but generic piece/box counts cannot', () => {
  expect(resolve({ item: { name: 'Synthetic 12 sachets', variant: '' } })).toMatchObject({ quantityPerSale: 12 });
  expect(resolve({ item: { name: 'Synthetic 12 pieces', variant: '' } }).reason).toBeDefined();
});

test('stock-frame evidence requires active exact product identity, unit label and both base factors', () => {
  for (const change of [{ active: false }, { companySku: 'other' }, { stockFactor: 2 }, { smallFactor: 2 }, { smallUnit: 'กล่อง' }]) {
    expect(stockContentFrame({ ...master, name: 'Synthetic 3 pieces' },
      { ...posProduct, productName: 'Synthetic 3 pieces', ...change }, normalizeUnit)).toBeNull();
  }
});
