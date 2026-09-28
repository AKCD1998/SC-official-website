const rules = require('../src/modules/seamless/data/shopeeAdaSmartCopyRules.v1.json');
const { resolveCopyProduct, buildAdaSmartCopyPlan } = require('../src/modules/seamless/services/shopeeAdaSmartCopyService');
const shopCode = 'sc-drug-store';
const evidenceId = 'stockday-004-20260928';
const additions = rules.rules.filter(r => r.evidence?.masterEvidenceId === evidenceId);
const sourceItem = (family, variant, quantity = 1) => {
  const rule = additions.find(r => r.shopCode === shopCode && r.productName.includes(family) && r.variant === variant);
  if (!rule) throw new Error(`Missing explicit fixture identity: ${family} / ${variant}`);
  return { name: rule.productName, variant, quantity, unitPrice: 50, productMatch: { status: 'unmapped' } };
};
const filters = { shopCode, startDate: '2026-09-13', endDate: '2026-09-13' };
const order = (items, amount, support = 0) => ({ shopCode, orderNumber: 'synthetic-stockday-order',
  paidAt: '2026-09-13T03:00:00Z', observedAt: '2026-09-28T00:00:00Z',
  sourceFilename: 'Order.all.20260901_20260927.xlsx', sourceSha256: 'a'.repeat(64),
  sourceRows: items.map((_, index) => 2 + index), items,
  itemSubtotal: amount, shopeeProductDiscount: support, sellerVoucher: 0 });
const confirmed = salesTotal => ({ ...filters, status: 'source_backed', salesTotal, orderCount: 1,
  shops: [{ shopCode, sources: [{ sourceSha256: 'b'.repeat(64) }] }] });

test('StockDay evidence is attributable and carries no ERP prices, balances or order identities', () => {
  const evidence = rules.additionalMasterEvidence.find(e => e.id === evidenceId);
  expect(evidence).toMatchObject({ branch: '004', sheet: 'Stock 004', verifiedOn: '2026-09-28',
    sha256: '7de45a7ca0adc8108f7757fe9af93ce6a7de15fca1c883e10f6542da9c3c3dce' });
  expect(evidence.records).toBeUndefined();
  const masters = new Map(rules.masters.map(m => [m.companySku, m]));
  expect(masters.size).toBe(rules.masters.length);
  expect(new Set(rules.rules.map(r => JSON.stringify([r.shopCode, r.productName, r.variant]))).size).toBe(rules.rules.length);
  for (const rule of additions) {
    for (const component of rule.components || [rule]) {
      expect(masters.has(component.companySku)).toBe(true);
      expect(Number.isSafeInteger(component.quantityPerSale)).toBe(true);
      expect(component.quantityPerSale).toBeGreaterThan(0);
    }
    expect(JSON.stringify(rule)).not.toMatch(/"(?:stock004|unitPrice|orderNumber|itemSubtotal|salePrice)"/u);
  }
});

test.each([
  ['TYLENOL', '1 กล่อง 20 แผง', '630010105', 20, 'แผง'],
  ['Mebendazole', '1 กล่อง 5 แผง', 'IC-004199', 5, 'แผง'],
  ['ศิริบัญชา', '1 แพ็ค', 'IC-000270', 6, 'ขวด'],
  ['ศิริบัญชา', '1 ลัง 24 ขวด', 'IC-000270', 24, 'ขวด'],
  ['Klean', '1ลัง 10 ขวด ดัมเบล', '630020295', 10, 'ขวด'],
  ['GHP', '1 ลัง 10 ขวด ดัมเบล', 'IC-005082', 10, 'ขวด'],
  ['One Gerd', '1 กล่อง 12 ซอง', 'IC-002441', 12, 'ซอง'],
  ['One Gerd', '1 ซอง 10 มล', 'IC-002441', 1, 'ซอง'],
  ['Berocca', '1 กล่อง', 'IC-005209', 7, 'ซอง'],
  ['Durex', '3 กล่อง', 'IC-000129', 3, 'ชิ้น'],
  ['SK Max', '2 แพ๊ค', 'IC-004177', 100, 'ชิ้น'],
  ['BioGaia', 'มินิแพ็ค ผง', 'IC-006042', 1, 'กล่อง'],
  ['Vita-C', 'สตรอว์เบอร์รี่,1 กระปุก 1000 เม็ด', 'IC-002913', 1, 'ขวด'],
  ['Vita-C', 'เลมอน,6 ซอง', 'IC-002484', 6, 'ซอง'],
  ['Royal-D', 'ผลไม้รวม', '630010187', 10, 'ซอง'],
  ['Royal-D', 'ส้ม', 'IC-005764', 10, 'ซอง'],
  ['Fairymed', '14 fr 1 ชิ้น ปลายปิด', 'IC-004871', 1, 'ชิ้น'],
  ['Fairymed', '16 fr 1 ชิ้น ปลายปิด', 'IC-004872', 1, 'ชิ้น'],
])('ERP package conversion preserves one source amount (%s / %s)', (family, variant, sku, factor, unit) => {
  const item = sourceItem(family, variant, 2);
  const plan = buildAdaSmartCopyPlan([order([item], 101, 1.01)], confirmed(102.01), filters);
  expect(plan.status).toBe('ready');
  expect(plan.totalQuantity).toBe(2 * factor);
  expect(plan.totalCents).toBe(10201);
  expect(plan.supportCents).toBe(101);
  expect(plan.rows.every(r => r.sku === sku && r.unit === unit)).toBe(true);
  expect(plan.rows.reduce((n, r) => n + Number(r.unitPrice.replace('.', '')) * r.quantity, 0)).toBe(10201);
  expect(plan.rows[0].sources[0]).toMatchObject({ listingQuantity: 2, quantityPerSale: factor,
    amountCents: 10201, sourceRow: 2, sourceSha256: 'a'.repeat(64) });
});

test('short One Gerd box title combines with sachet sales using one SKU and exact source cents', () => {
  const box = sourceItem('One Gerd', '1 กล่อง 12 ซอง', 3);
  const sachet = sourceItem('One Gerd', '1 ซอง 10 มล', 2);
  box.unitPrice = 156; sachet.unitPrice = 14;
  const plan = buildAdaSmartCopyPlan([order([box, sachet], 496)], confirmed(496), filters);
  expect(plan.status).toBe('ready');
  expect(plan.totalQuantity).toBe(38);
  expect(plan.columns).toEqual({ sku: 'IC-002441\nIC-002441', quantity: '10\n28', unitPrice: '13.06\n13.05' });
  expect(plan.totalCents).toBe(49600);
});

test('MYBACIN formulas stay separate despite their shared multi-formula title', () => {
  const items = ['มิ้นต์', 'ส้ม', 'มะนาว'].map(v => sourceItem('MYBACIN', v));
  const plan = buildAdaSmartCopyPlan([order(items, 150)], confirmed(150), filters);
  expect(plan.status).toBe('ready');
  expect(plan.rows.map(r => r.sku)).toEqual(['IC-002092', 'IC-004509', 'IC-004646']);
  expect(plan.totalQuantity).toBe(3);
});

test('known multi-SKU bundles report verified components and remain blocked for component prices', () => {
  const item = sourceItem('Polar Spray', 'ฝาฟ้า 2 แถม ฝาขาว');
  expect(resolveCopyProduct(shopCode, item)).toMatchObject({ components: [
    { sku: 'IC-002462', factor: 2, unit: 'กระป๋อง' }, { sku: 'IC-005557', factor: 1, unit: 'กระป๋อง' },
  ] });
  const plan = buildAdaSmartCopyPlan([order([item], 490)], confirmed(490), filters);
  expect(plan.status).toBe('review_required');
  expect(plan.columns).toBeNull(); expect(plan.rows).toEqual([]);
  expect(plan.issues[0].reason).toContain('IC-002462 ×2 + IC-005557 ×1');
  expect(plan.issues[0].reason).toContain('ราคา');
  expect(plan.cohortTotalCents).toBe(49000);
  const meterRule = additions.find(r => r.shopCode === 'dr-morepen' && r.components);
  const meter = resolveCopyProduct('dr-morepen', { name: meterRule.productName, variant: meterRule.variant });
  expect(meter.components.map(c => [c.sku, c.factor])).toEqual([['IC-003230', 1], ['IC-003478', 1]]);
  expect(meter.reason).toContain('ราคา');
});

test('new mappings retain date-independent exact identity boundaries and financial checks', () => {
  const item = sourceItem('One Gerd', '1 กล่อง 12 ซอง');
  for (const changed of [{ ...item, variant: '1 กล่อง 24 ซอง' }, { ...item, name: item.name.replace('มินท์', 'ส้ม') }]) {
    expect(resolveCopyProduct(shopCode, changed).reason).toBeTruthy();
  }
  expect(resolveCopyProduct('dr-morepen', item).reason).toBeTruthy();
  const futureFilters = { shopCode, startDate: '2027-01-02', endDate: '2027-01-02' };
  const futureOrder = { ...order([item], 100), paidAt: '2027-01-02T02:00:00Z', observedAt: '2027-01-03T01:00:00Z' };
  expect(buildAdaSmartCopyPlan([futureOrder], { ...confirmed(100), ...futureFilters }, futureFilters).status).toBe('ready');
  expect(buildAdaSmartCopyPlan([order([item], 100)], confirmed(101), filters).columns).toBeNull();
  const multi = [sourceItem('One Gerd', '1 กล่อง 12 ซอง'), sourceItem('MYBACIN', 'มิ้นต์')];
  const blocked = buildAdaSmartCopyPlan([order(multi, 100, 5)], confirmed(105), filters);
  expect(blocked.status).toBe('review_required'); expect(blocked.columns).toBeNull();
});
