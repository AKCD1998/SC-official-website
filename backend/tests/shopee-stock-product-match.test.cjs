const { resolveStockProductMatch } = require('../src/modules/seamless/services/shopeeStockProductMatch');
const item = { name: 'Synthetic item', variant: 'Synthetic pack' };
const match = () => ({ status: 'matched', companySku: 'synthetic-sku' });
const copy = () => ({ status: 'matched', rule: { companySku: 'synthetic-sku', quantityPerSale: 6 } });
const master = () => ({ unit: 'ซอง' });
const identifierConflict = () => null;
const options = { match, copy, master, identifierConflict };
test('existing reviewed pack evidence carries its explicit base unit and is later checked against live POS', () => {
  expect(resolveStockProductMatch('sc-drug-store', item, options)).toMatchObject({ status: 'matched',
    quantityRuleStatus: 'verified', quantityPerSale: 6, quantityUnit: 'ซอง' });
});
test.each([
  ['different SKU', { status: 'matched', companySku: 'different-sku' }],
  ['different pack count', { status: 'matched', companySku: 'synthetic-sku', quantityRuleStatus: 'verified', quantityPerSale: 12 }],
  ['accounting visibility mapping', { status: 'visibility_only' }],
  ['bundle cannot collapse into one SKU', { status: 'bundle' }],
])('%s remains unverified rather than choosing one authority', (_label, exact) => {
  expect(resolveStockProductMatch('sc-drug-store', item, { ...options, match: () => exact }))
    .toMatchObject({ status: 'unmapped', reasonCode: 'verified_mapping_evidence_conflict' });
});
test('unknown units cannot inherit a convenient POS label', () => {
  expect(resolveStockProductMatch('sc-drug-store', item, { ...options, master: () => null }).status).toBe('unmapped');
});
test('conflicting unit authorities are withheld even when one matches the POS unit', () => {
  expect(resolveStockProductMatch('sc-drug-store', item, { ...options,
    match: () => ({ ...match(), quantityUnit: 'box' }) })).toMatchObject({ status: 'unmapped', reasonCode: 'verified_mapping_evidence_conflict' });
});
test('a conflict in the verified-copy evidence cannot fall through to a convenient catalog match', () => {
  expect(resolveStockProductMatch('sc-drug-store', item, { ...options,
    copy: () => ({ status: 'review', reasonCode: 'automatic_evidence_conflict' }) }).status).toBe('unmapped');
});
test('conflicting source IDs block otherwise matching names', () => {
  expect(resolveStockProductMatch('sc-drug-store', item, { ...options, identifierConflict: () => 'conflict' }).status).toBe('unmapped');
});
test('failed copy evidence does not invent unit evidence for an ordinary name match', () => {
  const r = resolveStockProductMatch('sc-drug-store', item, { ...options, copy: () => ({ status: 'review' }) });
  expect(r).toEqual(match()); expect(r.quantityUnit).toBeUndefined();
});
test('IDs and barcodes are checked even when no copy rule exists', () => {
  const opts = { ...options, copy: () => ({ status: 'review' }) };
  expect(resolveStockProductMatch('sc-drug-store', { ...item, barcode: 'synthetic-barcode' }, opts).status).toBe('unmapped');
  expect(resolveStockProductMatch('sc-drug-store', { ...item, productId: 'synthetic-id' }, opts).status).toBe('unmapped');
});
