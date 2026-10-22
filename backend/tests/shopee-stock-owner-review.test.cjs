const ownerReview = require('../src/modules/seamless/data/shopeeStockOwnerReview.v1.json');
const { resolveStockProductMatch } = require('../src/modules/seamless/services/shopeeStockProductMatch');
const { matchShopeeProduct } = require('../src/modules/seamless/services/shopeeProductMatcher');
const { mapShopeeStockLines, projectShopeeStockShadow, summarizeStockShadow } = require('../src/modules/seamless/services/shopeeStockReservationShadow');
const entries = ownerReview.rules;
const item = r => ({ name: r.productName, variant: r.variant, quantity: 3 });
const pos = r => ({ companySku: r.companySku, stockCode: r.companySku, active: true,
  smallUnit: r.quantityUnit, smallFactor: 1, stockFactor: 1 });

test('review is confined to branch004 SC shadow with four distinct exact variants', () => {
  expect(ownerReview.scope).toEqual({ shopCode: 'sc-drug-store', branchCode: '004', mode: 'shadow-only' });
  expect(entries).toHaveLength(4);
  expect(new Set(entries.map(r => JSON.stringify([r.shopCode, r.productName, r.variant]))).size).toBe(4);
});

test.each(entries.map((r, i) => [i + 1, r]))('physical package %i is counted once, not by its internal contents', (_n, r) => {
  const m = resolveStockProductMatch(r.shopCode, item(r));
  expect(m).toMatchObject({ status: 'matched', companySku: r.companySku, quantityPerSale: 1,
    quantityUnit: r.quantityUnit, quantityEvidence: 'owner_confirmed_physical_stock_unit' });
  const mapped = mapShopeeStockLines({ items: [item(r)], posCatalog: [pos(r)] });
  expect(mapped).toMatchObject({ status: 'mapped', lines: [{ quantity: 3 }] });
});

test.each(entries.map((r, i) => [i + 1, r]))('physical package %i still checks source IDs, unknown barcodes and live unit evidence', (_n, r) => {
  expect(resolveStockProductMatch(r.shopCode, { ...item(r), productId: r.listingProductId,
    variationId: r.listingVariationId }).status).toBe('matched');
  for (const ids of [{ productId: 'synthetic-conflict' }, { productId: r.listingProductId },
    { productId: r.listingProductId, variationId: 'synthetic-conflict' },
    { productId: r.listingProductId, listingProductId: 'synthetic-conflict', variationId: r.listingVariationId }]) {
    expect(resolveStockProductMatch(r.shopCode, { ...item(r), ...ids }).status).toBe('unmapped');
  }
  expect(resolveStockProductMatch(r.shopCode, { ...item(r), barcode: 'synthetic-unverified' }).status).toBe('unmapped');
  for (const change of [{ active: false }, { smallUnit: 'synthetic-different-unit' }, { smallFactor: 2 }]) {
    expect(mapShopeeStockLines({ items: [item(r)], posCatalog: [{ ...pos(r), ...change }] }).status).toBe('blocked');
  }
});

test.each(entries.map((r, i) => [i + 1, r]))('physical package %i is not a shop-wide or variant-wide pcs alias', (_n, r) => {
  expect(resolveStockProductMatch('dr-morepen', item(r)).matchSource).not.toBe('owner_confirmed_exact_stock_variant');
  expect(resolveStockProductMatch(r.shopCode, { ...item(r), variant: `${r.variant} synthetic-other-model` }).matchSource)
    .not.toBe('owner_confirmed_exact_stock_variant');
});

test('a changed ERP base unit or unapproved authority cannot silently inherit an owner review', () => {
  const r = entries[0];
  expect(resolveStockProductMatch(r.shopCode, item(r), { master: () => ({ unit: 'synthetic-other-unit' }) }).status).toBe('unmapped');
  expect(resolveStockProductMatch(r.shopCode, item(r), { ownerReviews: [{ ...r, authority: 'unreviewed' }] }).status).toBe('unmapped');
  expect(resolveStockProductMatch(r.shopCode, item(r), { ownerReviews: [r, r] }).status).toBe('unmapped');
});

test('the owner physical correction leaves the existing financial visibility mapping intact', () => {
  const r = entries.find(x => x.sourceLabelMismatch);
  expect(matchShopeeProduct(r.shopCode, item(r)).status).toBe('visibility_only');
  expect(resolveStockProductMatch(r.shopCode, item(r))).toMatchObject({ status: 'matched',
    quantityPerSale: 1, sourceLabelMismatch: true });
});

test('a pre-existing exact catalog alias carries the same owner-reviewed identity, not a new name similarity match', () => {
  const r = entries.find(x => x.sourceLabelMismatch);
  const resolve = more => resolveStockProductMatch(r.shopCode, { name: 'Synthetic approved alias', variant: '' }, {
    match: () => ({ status: 'visibility_only', matchSource: 'catalog_identity_alias',
      listingProductId: r.listingProductId, listingVariationId: r.listingVariationId, ...more }) });
  expect(resolve({})).toMatchObject({ status: 'matched', companySku: r.companySku, quantityPerSale: 1, sourceLabelMismatch: true });
  expect(resolve({ listingVariationId: 'synthetic-other-variant' }).status).not.toBe('matched');
  expect(resolve({ matchSource: 'untrusted-similarity' }).status).not.toBe('matched');
});

test('sugar-free label mismatch stays visible in aggregate and cannot receive a clean readiness PASS', () => {
  const r = entries.find(x => x.sourceLabelMismatch);
  const projected = projectShopeeStockShadow({ asOf: '2026-10-22T12:20:00Z', posCatalog: [pos(r)],
    orders: [{ shopCode: r.shopCode, branchCode: '004', orderKey: 'synthetic-order', items: [item(r)] }],
    events: [{ shopCode: r.shopCode, branchCode: '004', orderKey: 'synthetic-order', eventKey: 'synthetic-event',
      occurredAt: '2026-10-22T12:00:00Z', type: 'order_confirmed' }],
    coverage: { emailComplete: true, lifecycleComplete: true, posLinksComplete: true, stockCutoverVerified: true } });
  const aggregate = summarizeStockShadow(projected);
  expect(aggregate).toMatchObject({ status: 'PARTIAL', sourceLabelMismatchOrders: 1,
    sourceLabelMismatchItemLines: 1, eligibleForLiveStock: false, websiteQuantitiesChanged: false });
  expect(JSON.stringify(aggregate)).not.toContain(r.companySku);
});
