jest.mock('../db', () => ({ query: jest.fn() }));
const { bundleAllocation } = require('../src/modules/seamless/services/shopeeCopyAllocation');
const { buildAdaSmartCopyPlan } = require('../src/modules/seamless/services/shopeeAdaSmartCopyService');
const rules = require('../src/modules/seamless/data/shopeeAdaSmartCopyRules.v1.json');
const shopCode = 'sc-drug-store';
const source = { sourceFilename: 'synthetic.xlsx', sourceSha256: 'a'.repeat(64), observedAt: '2020-01-02T00:00:00Z' };
const filters = { shopCode, startDate: '2020-01-01', endDate: '2020-01-01' };
const makePolicy = rule => ({ shopCode, policyKey: 'synthetic-positive-gift', enabled: true,
  approvedBy: 'synthetic-owner', approvedAt: '2020-01-02T00:00:00Z',
  approval: { kind: 'user_confirmed_allocation', caseId: 'synthetic', responseSha256: 'b'.repeat(64) },
  policy: { type: 'bundle', productName: rule.allocationIdentity?.productName || rule.productName,
    variant: rule.allocationIdentity?.variant || rule.variant,
    method: 'paid_component_with_nominal_gift_price', components: rule.components.map(part => ({
      sku: part.companySku, factor: part.quantityPerSale, weight: part.companySku === 'IC-002462' ? 1 : 0,
      ...(part.companySku !== 'IC-002462' ? { freeGift: true, giftUnitPriceCents: 10 } : {}) })) } });
const build = (rule, total, quantity = 1, extraItems = []) => {
  const order = { ...source, shopCode, orderNumber: '200101TEST01', paidAt: '2020-01-01T01:00:00Z',
    itemSubtotal: total, sellerVoucher: 0, shopeeProductDiscount: 0, sourceRows: [2, ...extraItems.map((_, index) => index + 3)],
    items: [{ name: rule.productName, variant: rule.variant, quantity,
      unitPrice: (total - extraItems.reduce((sum, part) => sum + part.quantity * part.unitPrice, 0)) / quantity,
      productMatch: { status: 'unmapped' } }, ...extraItems] };
  const before = JSON.stringify(order);
  const plan = buildAdaSmartCopyPlan([order], { ...filters, status: 'source_backed', salesTotal: total,
    orderCount: 1, shops: [{ shopCode, sources: [source] }] }, filters, [], [], { allocationPolicies: [makePolicy(rule)] });
  expect(JSON.stringify(order)).toBe(before);
  return plan;
};
const blue = rules.rules.find(rule => rule.components?.some(part => part.companySku === 'IC-006023'));
const white = rules.rules.find(rule => rule.components?.some(part => part.companySku === 'IC-005557') && !rule.allocationIdentity);
const renamedWhite = rules.rules.find(rule => rule.allocationIdentity && rule.components?.some(part => part.companySku === 'IC-005557'));

test.each([blue, white, renamedWhite])('positive gift allocation preserves a 495-baht bundle and both package counts: $variant', rule => {
  const plan = build(rule, 495);
  expect(plan.status).toBe('ready'); expect(plan.totalCents).toBe(49500);
  expect(plan.rows.find(row => row.sku === 'IC-002462')).toMatchObject({ quantity: 2, unitPrice: '247.45' });
  expect(plan.rows.find(row => row.freeGift)).toMatchObject({ quantity: 1, unitPrice: '0.10', amountCents: 10 });
});
test('gift amount scales with purchased bundles and odd satang stay exact without zero prices', () => {
  const plan = build(blue, 990.01, 2);
  expect(plan.status).toBe('ready'); expect(plan.totalCents).toBe(99001);
  expect(plan.rows.find(row => row.freeGift)).toMatchObject({ quantity: 2, unitPrice: '0.10', amountCents: 20 });
  expect(plan.rows.filter(row => !row.freeGift).map(row => [row.quantity, row.unitPrice]))
    .toEqual([[1, '247.46'], [3, '247.45']]);
});
test('nominal gifts remain separate from ordinary paid sales of the same SKU', () => {
  const plan = build(blue, 555, 1, [{ name: 'synthetic paid bottle', variant: '', quantity: 1, unitPrice: 60,
    productMatch: { status: 'matched', companySku: 'IC-006023' } }]);
  expect(plan.status).toBe('ready');
  expect(plan.rows.filter(row => row.sku === 'IC-006023').map(row => [row.quantity, row.unitPrice, Boolean(row.freeGift)]))
    .toEqual([[1, '60.00', false], [1, '0.10', true]]);
  expect(plan.totalCents).toBe(55500);
});
test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined])('invalid nominal gift amount %s stays blocked', giftUnitPriceCents => {
  const record = makePolicy(blue); record.policy.components[1].giftUnitPriceCents = giftUnitPriceCents;
  const parts = blue.components.map(part => ({ sku: part.companySku, factor: part.quantityPerSale }));
  expect(bundleAllocation([record], shopCode, { name: blue.productName, variant: blue.variant, quantity: 1 }, parts, 49500)).toBeNull();
});
test('absent, ambiguous, wrong identity and insufficient total cannot authorize a nominal gift', () => {
  const record = makePolicy(blue);
  const item = { name: blue.productName, variant: blue.variant, quantity: 1 };
  const parts = blue.components.map(part => ({ sku: part.companySku, factor: part.quantityPerSale }));
  for (const policies of [[], [record, record], [{ ...record, enabled: false }], [makePolicy(white)]])
    expect(bundleAllocation(policies, shopCode, item, parts, 49500)).toBeNull();
  expect(bundleAllocation([record], shopCode, item, parts, 10)).toBeNull();
  expect(bundleAllocation([record], shopCode, { ...item, quantity: 0 }, parts, 49500)).toBeNull();
  expect(bundleAllocation([record], shopCode, item, [parts[0], { ...parts[1], factor: 2 }], 49500)).toBeNull();
});
