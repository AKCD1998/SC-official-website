jest.mock('../db', () => ({ query: jest.fn() }));
const { allocateCents } = require('../src/modules/seamless/services/shopeeCopyAllocation');
const { buildAdaSmartCopyPlan, resolveLineAmounts } = require('../src/modules/seamless/services/shopeeAdaSmartCopyService');
const rules = require('../src/modules/seamless/data/shopeeAdaSmartCopyRules.v1.json');
const filters = { shopCode: 'sc-drug-store', startDate: '2020-01-01', endDate: '2020-01-01' };
const source = { sourceFilename: 'synthetic.xlsx', sourceSha256: 'a'.repeat(64), observedAt: '2020-01-02T00:00:00Z' };
const item = (sku, unitPrice = 174, quantity = 1) => ({ name: 'synthetic', variant: '', unitPrice, quantity,
  productMatch: { status: 'matched', companySku: sku } });
const order = (overrides = {}) => ({ ...source, shopCode: filters.shopCode, orderNumber: '200101TEST01',
  paidAt: '2020-01-01T01:00:00Z', items: [item('630010066'), item('IC-003143')], sourceRows: [2, 3],
  itemSubtotal: 348, shopeeProductDiscount: 0, sellerVoucher: 10, ...overrides });
const policy = (definition, shopCode = filters.shopCode, policyKey = 'synthetic') => ({ shopCode, policyKey,
  enabled: true, approvedBy: 'synthetic-owner', approvedAt: '2020-01-02T02:00:00Z', policy: definition,
  approval: { kind: 'user_confirmed_allocation', caseId: 'synthetic', responseSha256: 'b'.repeat(64) } });
const sellerPolicy = policy({ type: 'seller_voucher', method: 'proportional_net_merchandise_largest_remainder' });
const bi = (salesTotal, orderCount = 1, f = filters) => ({ ...f, status: 'source_backed', salesTotal, orderCount,
  shops: [{ shopCode: f.shopCode, sources: [source] }] });
const build = (orders, total, context, f = filters) => buildAdaSmartCopyPlan(orders, bi(total, orders.length, f), f, [], [], context);

test('approved seller allocation deducts exactly ten baht without altering source', () => {
  const o = order(); const before = JSON.stringify(o);
  const plan = build([o], 338, { allocationPolicies: [sellerPolicy] });
  expect(plan.status).toBe('ready'); expect(plan.columns.unitPrice).toBe('169.00\n169.00');
  expect(plan.sellerCents).toBe(1000); expect(plan.totalCents).toBe(33800);
  expect(plan.allocationPolicies[0].approval.kind).toBe('user_confirmed_allocation');
  expect(JSON.stringify(o)).toBe(before);
});

test('seller weights are net merchandise; documented Shopee support is added once after the allocation', () => {
  const o = order({ itemSubtotal: 300, shopeeProductDiscount: 63,
    lineFinancials: [{ netSale: 100, shopeeProductDiscount: 63 }, { netSale: 200, shopeeProductDiscount: 0 }] });
  const money = resolveLineAmounts(o, { allocationPolicies: [sellerPolicy] });
  expect(money.allocatedSellerCents).toEqual([333, 667]);
  expect(money.amounts).toEqual([15967, 19333]);
  expect(build([o], 353, { allocationPolicies: [sellerPolicy] }).status).toBe('ready');
});

test('largest remainder ties follow source order and arithmetic stays exact at large values', () => {
  expect(allocateCents(1, [1, 1, 1])).toEqual([1, 0, 0]);
  expect(allocateCents(5, [0, 1, 1])).toEqual([0, 3, 2]);
  expect(allocateCents(Number.MAX_SAFE_INTEGER, [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]))
    .toEqual([4503599627370496, 4503599627370495]);
  expect(allocateCents(1, [0, 0])).toBeNull();
});

test.each([
  [], [{ ...sellerPolicy, enabled: false }], [{ ...sellerPolicy, shopCode: 'dr-morepen' }],
  [{ ...sellerPolicy, approvedBy: '' }], [{ ...sellerPolicy, approval: { kind: 'matching_total_only' } }],
  [sellerPolicy, sellerPolicy],
].map(value => [value]))('missing, disabled, invalid or ambiguous approval keeps copy blocked (%j)', allocationPolicies => {
  expect(build([order()], 338, { allocationPolicies }).columns).toBeNull();
});

test('matching BI does not waive absent per-product support or drifted source line totals', () => {
  const o = order({ shopeeProductDiscount: 1 });
  expect(build([o], 339, { allocationPolicies: [sellerPolicy] }).columns).toBeNull();
  expect(build([order({ lineFinancials: [{ netSale: 174, shopeeProductDiscount: 0 },
    { netSale: 173, shopeeProductDiscount: 0 }] })], 338, { allocationPolicies: [sellerPolicy] }).columns).toBeNull();
});

const polarRule = rules.rules.find(row => row.components && row.shopCode === filters.shopCode);
const polar = (quantity = 1) => ({ name: polarRule.productName, variant: polarRule.variant, quantity, unitPrice: 485,
  productMatch: { status: 'unmapped' } });
const polarPolicy = policy({ type: 'bundle', productName: polarRule.productName, variant: polarRule.variant,
  method: 'paid_component_and_free_gift', components: [
    { sku: 'IC-002462', factor: 2, weight: 1 }, { sku: 'IC-005557', factor: 1, weight: 0, freeGift: true },
  ] }, filters.shopCode, 'polar');

test.each([456, 485, 490, 495])('Polar uses the actual source bundle amount %s and preserves the free gift at zero', total => {
  const o = order({ items: [polar()], sourceRows: [2], itemSubtotal: total, sellerVoucher: 0 });
  const plan = build([o], total, { allocationPolicies: [polarPolicy] });
  expect(plan.status).toBe('ready');
  expect(plan.rows.find(row => row.sku === 'IC-005557')).toMatchObject({ quantity: 1, unitPrice: '0.00', freeGift: true });
  expect(plan.rows.filter(row => row.sku === 'IC-002462').reduce((sum, row) => sum + row.amountCents, 0)).toBe(total * 100);
  expect(plan.totalQuantity).toBe(3);
});

test('three Polar bundles produce six paid blue and three free white; paid white sales keep their price', () => {
  const plan = build([order({ items: [polar(3)], sourceRows: [2], itemSubtotal: 1485, sellerVoucher: 0 }),
    order({ orderNumber: '200101WHITE02', items: [item('IC-005557', 60, 2)], sourceRows: [3], itemSubtotal: 120, sellerVoucher: 0 })],
  1605, { allocationPolicies: [polarPolicy] });
  expect(plan.status).toBe('ready'); expect(plan.skuCount).toBe(2);
  expect(plan.rows.map(row => [row.sku, row.quantity, row.unitPrice]))
    .toEqual([['IC-002462', 6, '247.50'], ['IC-005557', 2, '60.00'], ['IC-005557', 3, '0.00']]);
});

test('bundle approval cannot waive unconfirmed quantities, identities, or component factors', () => {
  const base = order({ items: [polar()], sourceRows: [2], itemSubtotal: 485, sellerVoucher: 0 });
  for (const context of [{}, { allocationPolicies: [{ ...polarPolicy, enabled: false }] },
    { allocationPolicies: [{ ...polarPolicy, policy: { ...polarPolicy.policy,
      components: [{ sku: 'IC-002462', factor: 1, weight: 1 }, polarPolicy.policy.components[1]] } }] }]) {
    expect(build([base], 485, context).columns).toBeNull();
  }
  expect(build([{ ...base, items: [{ ...polar(), quantity: 0 }] }], 485, { allocationPolicies: [polarPolicy] }).columns).toBeNull();
  expect(build([{ ...base, items: [{ ...polar(), name: `${polar().name} different` }] }], 485,
    { allocationPolicies: [polarPolicy] }).columns).toBeNull();
});

const drRule = rules.rules.find(row => row.components && row.shopCode === 'dr-morepen');
const drPolicy = policy({ type: 'bundle', productName: drRule.productName, variant: drRule.variant,
  method: 'equal_components', sourcePriceCentsPerSale: 35000,
  components: [{ sku: 'IC-003230', factor: 1, weight: 1 }, { sku: 'IC-003478', factor: 1, weight: 1 }] }, 'dr-morepen', 'dr');
test('DR approved 350-baht bundle allocates 175 to each item, scoped to that source price', () => {
  const f = { ...filters, shopCode: 'dr-morepen' };
  const o = order({ shopCode: f.shopCode, items: [{ name: drRule.productName, variant: drRule.variant,
    quantity: 2, unitPrice: 350, productMatch: { status: 'unmapped' } }], sourceRows: [2], itemSubtotal: 700, sellerVoucher: 0 });
  const plan = build([o], 700, { allocationPolicies: [drPolicy] }, f);
  expect(plan.status).toBe('ready'); expect(plan.columns.unitPrice).toBe('175.00\n175.00');
  expect(plan.columns.quantity).toBe('2\n2');
  expect(build([{ ...o, itemSubtotal: 800 }], 800, { allocationPolicies: [drPolicy] }, f).columns).toBeNull();
});

const campaign = { shopCode: filters.shopCode, voucherId: 'SYNTHETIC-SELLER', voucherName: 'synthetic',
  validFrom: '2019-12-31T17:00:00Z', validTo: '2020-01-01T16:59:59.999Z', discountRate: 0.05,
  maxDiscount: 10, minSpend: 110, appliesToAllProducts: true, sourceUrl: 'https://example.invalid/voucher',
  sourceObservedAt: '2020-01-03T00:00:00Z' };
const cancelled = order({ items: [item('630010066', 231)], sourceRows: [2], itemSubtotal: 231,
  sellerVoucher: 0, excluded: true, voucherCodes: [campaign.voucherId] });
const history = [cancelled];
test('the same existing exact campaign evidence restores a cancelled single-item discount once', () => {
  const before = JSON.stringify(cancelled);
  const plan = build([cancelled], 221, { orderSnapshots: history, sellerVoucherEvidence: [campaign] });
  expect(plan.status).toBe('ready'); expect(plan.columns.unitPrice).toBe('221.00');
  expect(plan.sellerVoucherRestorations[0].restoredAmount).toBe(10);
  expect(plan.sellerCents).toBe(1000); expect(JSON.stringify(cancelled)).toBe(before);
});

test('an unrelated campaign period leaves already-reconciled original cancelled sales unchanged', () => {
  const inactive = { ...campaign, validFrom: '2020-01-02T00:00:00Z', validTo: '2020-01-03T00:00:00Z' };
  const plan = build([cancelled], 231, { orderSnapshots: history, sellerVoucherEvidence: [inactive] });
  expect(plan.status).toBe('ready'); expect(plan.columns.unitPrice).toBe('231.00');
  expect(plan.sellerVoucherRestorations).toEqual([]);
});

test.each([
  ['no campaign', history, []], ['wrong shop', history, [{ ...campaign, shopCode: 'dr-morepen' }]],
  ['outside payment window', history, [{ ...campaign, validFrom: '2020-01-02T00:00:00Z' }]],
  ['conflicting original codes', [{ ...cancelled, sourceSha256: 'c'.repeat(64), observedAt: '2020-01-01T02:00:00Z', voucherCodes: [] }, cancelled], [campaign]],
  ['changed original product', [{ ...cancelled, sourceSha256: 'c'.repeat(64), observedAt: '2020-01-01T02:00:00Z', items: [item('630010066', 232)] }, cancelled], [campaign]],
  ['fractional satang', history, [{ ...campaign, discountRate: 0.00001 }]],
])('%s cannot manufacture a voucher to match BI', (_, orderSnapshots, sellerVoucherEvidence) => {
  expect(build([cancelled], 221, { orderSnapshots, sellerVoucherEvidence }).columns).toBeNull();
});

test('restoration and proportional seller allocation work together without deducting twice', () => {
  const o = order({ sellerVoucher: 0, excluded: true, voucherCodes: [campaign.voucherId] });
  const plan = build([o], 338, { orderSnapshots: [o], sellerVoucherEvidence: [campaign], allocationPolicies: [sellerPolicy] });
  expect(plan.status).toBe('ready'); expect(plan.columns.unitPrice).toBe('169.00\n169.00');
  expect(plan.sellerCents).toBe(1000);
});
