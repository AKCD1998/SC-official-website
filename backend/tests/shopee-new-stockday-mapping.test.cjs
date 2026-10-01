const rules = require('../src/modules/seamless/data/shopeeAdaSmartCopyRules.v1.json');
const { resolveCopyProduct, buildAdaSmartCopyPlan } = require('../src/modules/seamless/services/shopeeAdaSmartCopyService');
const shopCode = 'sc-drug-store';
const evidenceId = 'stockday-004-20260930';
const additions = rules.rules.filter(r => r.evidence?.masterEvidenceId === evidenceId && r.verifiedOn === '2026-09-30');
const fixtures = [
  ['Ensure Gold AdvancePro', '', 'IC-000988', 1, 'กระป๋อง'],
  ['BACTIGRAS', '3 กล่อง', 'IC-000295', 30, 'แผ่น'],
  ['SOS Plus', 'T 9x15 ซม.', 'IC-001203', 1, 'กล่อง'],
  ['SOS Plus', 'T4 10x25 ซม.', 'IC-000521', 1, 'กล่อง'],
  ['Durex Protect', '3 กล่อง', 'IC-002111', 3, 'ชิ้น'],
  ['I-HERB OTC', '60 มล', 'IC-004261', 1, 'ขวด'],
  ['Swisse', 'ซันนี่เดย์ สีม่วง', 'IC-005339', 1, 'กระปุก'],
  ['ยาดม ตรา แทนใจ', 'ฟ้า', 'IC-006114', 1, 'ชิ้น'],
  ['Durex ดูเร็กซ์', 'คิงเท็ค 1 กล่อง', 'IC-000066', 1, 'ชิ้น'],
  ['I-Herb ไอ-เฮิร์บ', 'เม็ดอม 8 เม็ด', 'IC-004806', 1, 'ซอง'],
  ['Vita-C', 'องุ่น,1 กระปุก 1000 เม็ด', 'IC-002911', 1, 'ขวด'],
  ['แป้งโยคีในรัศมีวงกลม', '100 กรัม', 'IC-005707', 1, 'ขวด'],
];
function itemFor(family, variant, quantity = 2) {
  const matches = additions.filter(r => r.productName.includes(family) && r.variant === variant);
  expect(matches).toHaveLength(1);
  return { name: matches[0].productName, variant, quantity, unitPrice: 50, productMatch: { status: 'unmapped' } };
}
function planFor(item, salesTotal = 102.01, date = '2026-09-29') {
  const filters = { shopCode, startDate: date, endDate: date };
  const order = { shopCode, orderNumber: 'synthetic-new-package', paidAt: `${date}T03:00:00Z`,
    observedAt: `${date}T04:00:00Z`, sourceFilename: 'synthetic.xlsx', sourceSha256: 'a'.repeat(64),
    sourceRows: [2], items: [item], itemSubtotal: 101, shopeeProductDiscount: 1.01, sellerVoucher: 0 };
  const confirmed = { ...filters, status: 'source_backed', salesTotal, orderCount: 1,
    shops: [{ shopCode, sources: [{ sourceSha256: 'b'.repeat(64) }] }] };
  return buildAdaSmartCopyPlan([order], confirmed, filters);
}
test.each(fixtures)('%s / %s converts to ERP units while preserving source cents', (family, variant, sku, factor, unit) => {
  const item = itemFor(family, variant);
  expect(resolveCopyProduct(shopCode, item)).toMatchObject({ sku, factor, unit });
  const plan = planFor(item);
  expect(plan.status).toBe('ready');
  expect(plan.totalQuantity).toBe(2 * factor);
  expect(plan.totalCents).toBe(10201);
  expect(plan.supportCents).toBe(101);
  expect(plan.rows.every(r => r.sku === sku && r.unit === unit)).toBe(true);
  expect(plan.rows.reduce((n, r) => n + Number(r.unitPrice.replace('.', '')) * r.quantity, 0)).toBe(10201);
  expect(plan.rows[0].sources[0]).toMatchObject({ listingQuantity: 2, quantityPerSale: factor, amountCents: 10201 });
});
test('Protect 4 bundles of 3 boxes produces 12 ERP retail boxes, not 36 condoms', () => {
  const plan = planFor(itemFor('Durex Protect', '3 กล่อง', 4));
  expect(plan.totalQuantity).toBe(12);
  expect(plan.totalCents).toBe(10201);
});
test('user-confirmed zip sachet remains separate from the historical standard sachet and OTC 18-count', () => {
  const zip = itemFor('I-Herb ไอ-เฮิร์บ', 'เม็ดอม 8 เม็ด');
  expect(resolveCopyProduct(shopCode, zip)).toMatchObject({ sku: 'IC-004806', factor: 1 });
  expect(resolveCopyProduct(shopCode, { ...zip, variant: 'ยาอม OTC 18 เม็ด' })).toMatchObject({ sku: 'IC-005056', factor: 1 });
  const { enrichShopeeOrderItems } = require('../src/modules/seamless/services/shopeeProductMatcher');
  const catalog = require('../src/modules/seamless/data/shopeeProductCatalog.v1.json');
  const original = catalog.records.find(r => r.productId === '40483166601');
  const standard = enrichShopeeOrderItems(shopCode, [{ name: original.productName, variant: original.variant, quantity: 1 }])[0];
  expect(resolveCopyProduct(shopCode, standard)).toMatchObject({ sku: 'IC-003652', factor: 1 });
  const rule = additions.find(r => r.companySku === 'IC-004806');
  expect(rule.authority).toContain('user_confirmed_pack');
  expect(rule.evidence.erpBarcode).toBe('8858923910096');
  expect(additions).toHaveLength(12);
});
test('identity rules are shop/variant scoped and future dated sales still require BI agreement', () => {
  const item = itemFor('SOS Plus', 'T 9x15 ซม.');
  expect(resolveCopyProduct(shopCode, { ...item, variant: 'SB 9x15 ซม.' }).reason).toBeTruthy();
  expect(resolveCopyProduct('dr-morepen', item).reason).toBeTruthy();
  expect(resolveCopyProduct(shopCode, { ...item, name: item.name.replace('ใสปิดแผลกันน้ำ', 'ผ้าก๊อซ') }).reason).toBeTruthy();
  expect(planFor(item, 102.01, '2027-01-02').status).toBe('ready');
  expect(planFor(item, 102.02).columns).toBeNull();
  expect(resolveCopyProduct(shopCode, { ...itemFor('Swisse', 'ซันนี่เดย์ สีม่วง'), variant: 'สูตรใหม่สีม่วง' }).reason).toBeTruthy();
  expect(resolveCopyProduct(shopCode, { ...itemFor('Vita-C', 'องุ่น,1 กระปุก 1000 เม็ด'), variant: 'องุ่น,1 ซอง 30 เม็ด' }).reason).toBeTruthy();
});
test('fresh stock evidence is durable and omits prices, balances and source orders', () => {
  expect(rules.additionalMasterEvidence.find(e => e.id === evidenceId)).toMatchObject({
    branch: '004', sheet: 'Stock 004', verifiedOn: '2026-09-30', syncAt: '2026-09-30T08:21:03+07:00',
    sha256: 'e5fb358d36946bda528db9c6c99836ba43800bf137ed768528bdde47c2454afe' });
  for (const rule of additions) {
    expect(rule.evidence.erpBarcode).toBeTruthy();
    expect(JSON.stringify(rule)).not.toMatch(/"(?:stock004|unitPrice|orderNumber|itemSubtotal|salePrice)"/u);
  }
  expect(new Set(rules.masters.map(m => m.companySku)).size).toBe(rules.masters.length);
  expect(new Set(rules.rules.map(r => JSON.stringify([r.shopCode, r.productName, r.variant]))).size).toBe(rules.rules.length);
});
