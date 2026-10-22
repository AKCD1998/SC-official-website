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
  ['different pack count', { status: 'matched', companySku: 'synthetic-sku', quantityRuleStatus: 'verified', quantityPerSale: 12, quantityUnit: 'sachet' }],
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
    match: () => ({ ...match(), quantityUnit: 'box' }) })).toMatchObject({ status: 'unmapped', reasonCode: 'sale_unit_pos_mismatch' });
});
test('a conflict in the verified-copy evidence cannot fall through to a convenient catalog match', () => {
  expect(resolveStockProductMatch('sc-drug-store', item, { ...options,
    copy: () => ({ status: 'review', reasonCode: 'automatic_evidence_conflict' }) }).status).toBe('unmapped');
});
test('conflicting source IDs block otherwise matching names', () => {
  expect(resolveStockProductMatch('sc-drug-store', item, { ...options, identifierConflict: () => 'conflict' }).status).toBe('unmapped');
});
test('an exact reviewed ordinary SKU uses its independently known ERP base unit, not the 13-SKU exception table', () => {
  const r = resolveStockProductMatch('sc-drug-store', item, { ...options, copy: () => ({ status: 'review' }) });
  expect(r).toMatchObject({ status: 'matched', quantityPerSale: 1, quantityUnit: 'ซอง', quantityRuleStatus: 'verified' });
  expect(resolveStockProductMatch('sc-drug-store', item, { ...options, master: () => null,
    copy: () => ({ status: 'review' }) }).status).toBe('unmapped');
  expect(resolveStockProductMatch('sc-drug-store', { ...item, variant: '10 packs' }, {
    ...options, copy: () => ({ status: 'review' }) }).status).toBe('unmapped');
});
test('IDs and barcodes are checked even when no copy rule exists', () => {
  const opts = { ...options, copy: () => ({ status: 'review' }) };
  expect(resolveStockProductMatch('sc-drug-store', { ...item, barcode: 'synthetic-barcode' }, opts).status).toBe('unmapped');
  expect(resolveStockProductMatch('sc-drug-store', { ...item, productId: 'synthetic-id' }, opts).status).toBe('unmapped');
});

test('independent stock-pack contents supersede the old inferred copy count, not a reviewed physical override', () => {
  const contents = { name: 'Synthetic 3 pieces', variant: '1 box 3 pieces' };
  const m = { companySku: 'synthetic-sku', unit: 'ชิ้น', name: 'Synthetic 3 pieces' };
  const p = { ...m, productName: m.name, active: true, stockFactor: 1, smallFactor: 1, smallUnit: 'ชิ้น' };
  const opts = { match, master: () => m, identifierConflict, rules: [],
    posCatalog: new Map([['synthetic-sku', p]]) };
  expect(resolveStockProductMatch('sc-drug-store', contents, { ...opts,
    copy: () => ({ status: 'matched', rule: { companySku: 'synthetic-sku', quantityPerSale: 3,
      authority: 'existing_verified_catalog' } }) })).toMatchObject({ status: 'matched', quantityPerSale: 1 });
  expect(resolveStockProductMatch('sc-drug-store', contents, { ...opts,
    copy: () => ({ status: 'matched', rule: { companySku: 'synthetic-sku', quantityPerSale: 3,
      authority: 'independently_reviewed_physical_pack' } }) }).status).toBe('unmapped');
});

test('an exact financial consolidation override cannot become a physical stock mapping', () => {
  expect(resolveStockProductMatch('sc-drug-store', item, { ...options,
    rules: [{ shopCode: 'sc-drug-store', productName: item.name, variant: item.variant,
      companySku: 'synthetic-sku', quantityPerSale: 1, authority: 'user_authorized_accounting_consolidation' }] }))
    .toMatchObject({ status: 'unmapped', reasonCode: 'physical_stock_rule_required' });
});
