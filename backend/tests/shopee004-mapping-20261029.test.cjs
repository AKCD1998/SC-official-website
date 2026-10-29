const fixture = require('./fixtures/shopee004-mapping-20261029.json');
const { randomUUID } = require('node:crypto');
const { createShopee004IdentityStore } = require('../src/modules/seamless/services/shopee004IdentityStore');
const { buildCatalogIdentityApproval } = require('../src/modules/seamless/services/shopee004CatalogApproval');
const { normalizeTrustedEvidenceFact, deriveTrustedEvidenceSnapshot } = require('../src/modules/seamless/services/shopee004TrustedEvidence');
const { validateCatalog } = require('../src/modules/seamless/services/shopee004StockPolicy');
const { mapShopeeStockLines } = require('../src/modules/seamless/services/shopeeStockReservationShadow');

// Regression inputs only. Runtime continues to read the existing versioned DB
// registry. Neither this fixture nor this test imports/approves production facts.
async function context(binding, { aliases, pos = binding.pos } = {}) {
  aliases ||= [{ productName: binding.productName, variantName: binding.variantName }];
  const common = { ...fixture.scope, listingId: binding.listingId, variationId: binding.variationId,
    observedAt: fixture.observedAt };
  const facts = [
    { ...common, reference: randomUUID(), kind: 'seller_catalog', catalogVersion: fixture.version,
      sourceSkus: [binding.sourceSku], aliases, packText: binding.evidence },
    { ...common, reference: randomUUID(), kind: 'seller_description', aliases, components: binding.components },
    { ...common, reference: randomUUID(), kind: 'pos_unit', productCode: binding.pos.companySku,
      stockCode: binding.pos.stockCode, unit: binding.pos.smallUnit, stockFactor: 1, smallFactor: 1 },
  ].map(f => normalizeTrustedEvidenceFact(f));
  const posCatalog = validateCatalog([pos]);
  const evidenceRefs = deriveTrustedEvidenceSnapshot(new Map(facts.map(f => [f.reference, { ...f.details, kind: f.kind }])));
  const request = { listingId: binding.listingId, variationId: binding.variationId, expectedVersion: 0,
    expectedCatalogVersion: fixture.version, acknowledgeUnitEvidence: true,
    components: binding.components, evidenceRefs: facts.map(f => f.reference) };
  const { rule } = buildCatalogIdentityApproval({ versions: [], posCatalog, evidenceRefs }, request);
  const queries = [];
  const client = { release() {}, query: async config => {
    const sql = typeof config === 'string' ? config : config.text;
    queries.push(sql);
    if (sql.includes('identity_rule_versions')) return { rows: [{ rule }] };
    if (sql.includes('identity_evidence')) return { rows: facts };
    if (sql.includes('stock_control')) return { rows: [{ mode: 'live', pos_catalog: [pos] }] };
    if (/^(BEGIN|SET |COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
    throw Error('UNEXPECTED_QUERY');
  } };
  const store = createShopee004IdentityStore({ pool: { connect: async () => client }, schema: 'test_only', ledger: () => { throw Error('NO_LEDGER_WRITE'); } });
  const matchItem = await store.mappingContextProvider(client, { pos_catalog: [pos] });
  return { matchItem, posCatalog, rule, store, queries };
}

test.each(fixture.bindings.map(b => [b.variationId, b]))('verified variation %s uses exact identity and POS sale units', async (_id, b) => {
  const { matchItem, posCatalog, store, queries } = await context(b);
  const item = { name: b.oldName, variant: b.oldVariant, quantity: 3 };
  const map = extra => mapShopeeStockLines({ items: [{ ...item, ...extra }], matchItem, posCatalog });
  expect(map()).toMatchObject({ status: 'mapped', lines: b.components.map(c => ({ stockCode: c.productCode, quantity: c.quantityPerSale * 3 })) });
  expect(map({ listingProductId: b.listingId, listingVariationId: b.variationId, sourceSku: b.sourceSku }).status).toBe('mapped');
  for (const extra of [{ sourceSku: 'CONFLICT' }, { productId: 'WRONG', variationId: b.variationId },
    { listingId: b.listingId }, { sourceBarcode: 'UNVERIFIED' }, { variant: b.oldVariant + ' unknown pack' }]) {
    expect(map(extra).status).toBe('blocked');
  }
  const changedPos = new Map(posCatalog);
  changedPos.set(b.pos.companySku, { ...b.pos, smallUnit: 'CONTRADICTORY_UNIT' });
  expect(mapShopeeStockLines({ items: [item], matchItem, posCatalog: changedPos }).status).toBe('blocked');
  expect(matchItem('another-shop', item)).toMatchObject({ status: 'unmapped', reasonCode: 'unsupported_shop' });
  const accountingMatch = { status: 'unmapped', reasonCode: 'accounting_price_review' };
  const source = { shopCode: 'sc-drug-store', items: [{ ...item, unitPrice: 123, productMatch: accountingMatch }] };
  const [display] = await store.enrichOrdersForStockDisplay([source]);
  expect(display.items[0].stockProductMatch).toEqual({ status: 'verified', branchCode: '004',
    components: b.components.map(c => ({ companySku: c.productCode, quantityPerSale: c.quantityPerSale, quantityUnit: c.unit })) });
  expect(display.items[0].productMatch).toBe(accountingMatch);
  expect(display.items[0].unitPrice).toBe(123);
  expect(source.items[0].stockProductMatch).toBeUndefined();
  expect(queries).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  expect(queries.every(sql => /^(SELECT |BEGIN |SET |COMMIT)/.test(sql))).toBe(true);
});

test('a title rename needs its own exact evidenced alias, even when stable IDs agree', async () => {
  const b = fixture.bindings[2], renamed = b.productName + ' renamed';
  const original = await context(b);
  const item = { name: renamed, variant: b.variantName, quantity: 1,
    listingProductId: b.listingId, listingVariationId: b.variationId };
  expect(original.matchItem('sc-drug-store', item)).toMatchObject({ status: 'unmapped', reasonCode: 'identity_rule_source_drift' });
  const reviewed = await context(b, { aliases: [{ productName: b.productName, variantName: b.variantName },
    { productName: renamed, variantName: b.variantName }] });
  for (const name of [b.productName, renamed]) expect(mapShopeeStockLines({ items: [{ ...item, name }], ...reviewed }).status).toBe('mapped');
});

test('package counts do not multiply retail contents or borrow another option factor', () => {
  const factors = Object.fromEntries(fixture.bindings.map(b => [b.sourceSku, [b.components[0].quantityPerSale, b.components[0].unit]]));
  expect(factors).toMatchObject({ 'IC-000060': [1, 'กล่อง'], '630010163': [1, 'กล่อง'],
    'IC-006137': [1, 'กล่อง'], '630010040': [1, 'ซอง'], 'IC-002913': [1, 'ขวด'],
    'IC-000023': [50, 'แผง'], 'IC-005886': [10, 'ซอง'], 'IC-001510': [24, 'ซอง'], 'IC-005598': [10, 'ชิ้น'] });
});
