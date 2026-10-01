const { buildAdaSmartCopyPlan } = require('../src/modules/seamless/services/shopeeAdaSmartCopyService');
const { summarizeConfirmedSales } = require('../src/modules/seamless/services/shopeeConfirmedSalesService');
const { sourceFactFingerprint } = require('../src/modules/seamless/services/shopeeCopyBusinessDate');

const shopCode = 'sc-drug-store';
const filters = { shopCode, startDate: '2026-09-01', endDate: '2026-09-03' };
const fact = (date, salesTotal, orderCount) => ({ shopCode, date, salesTotal, orderCount,
  cancelledSales: 0, cancelledOrderCount: 0, returnedSales: 0, returnedOrderCount: 0,
  sourceFilename: 'synthetic-bi-range.xlsx', sourceSha256: 'b'.repeat(64), observedAt: '2026-10-01T00:00:00Z' });
const order = (id, date, amount, quantity = 1, extra = {}) => ({ shopCode, orderNumber: id,
  paidAt: `${date}T03:00:00Z`, orderedAt: `${date}T02:00:00Z`, observedAt: '2026-10-01T00:00:00Z',
  sourceFilename: 'synthetic-orders.xlsx', sourceSha256: 'a'.repeat(64), sourceRows: [2],
  itemSubtotal: amount, sellerVoucher: 0, shopeeProductDiscount: 0,
  items: [{ name: 'Synthetic product', variant: '', quantity, unitPrice: amount / quantity,
    productMatch: { status: 'matched', companySku: '630010066' } }], ...extra });
const build = (orders, facts, scope = filters, corrections = []) => buildAdaSmartCopyPlan(orders,
  summarizeConfirmedSales(facts, scope), scope, corrections);

test('range consolidates source amounts and ERP quantities before exact-cent pricing, with explicit zero days', () => {
  const orders = [order('FIRST', filters.startDate, 100, 3), order('LAST', filters.endDate, 35.51, 2)];
  const before = JSON.stringify(orders);
  const plan = build(orders, [fact('2026-09-01', 100, 1), fact('2026-09-02', 0, 0), fact('2026-09-03', 35.51, 1)]);
  expect(plan).toMatchObject({ status: 'ready', orderCount: 2, totalQuantity: 5, totalCents: 13551, targetCents: 13551 });
  expect(plan.columns).toEqual({ sku: '630010066\n630010066', quantity: '1\n4', unitPrice: '27.11\n27.10' });
  expect(plan.dailyReconciliation.map(day => [day.date, day.status, day.orderCount, day.targetCents]))
    .toEqual([['2026-09-01', 'ready', 1, 10000], ['2026-09-02', 'ready', 0, 0], ['2026-09-03', 'ready', 1, 3551]]);
  expect(plan.rows[0].sources.map(source => source.amountCents)).toEqual([10000, 3551]);
  expect(JSON.stringify(orders)).toBe(before);
});

test('a missing BI day cannot be treated as zero or be hidden by a matching grand total', () => {
  const orders = [order('FIRST', '2026-09-01', 100), order('LAST', '2026-09-03', 35.51)];
  const facts = [fact('2026-09-01', 100, 1), fact('2026-09-03', 35.51, 1)];
  const confirmed = { ...summarizeConfirmedSales(facts, filters), status: 'source_backed', salesTotal: 135.51, orderCount: 2 };
  const plan = buildAdaSmartCopyPlan(orders, confirmed, filters);
  expect(plan.totalCents).toBe(plan.targetCents);
  expect(plan.columns).toBeNull();
  expect(plan.dailyReconciliation[1]).toMatchObject({ date: '2026-09-02', status: 'review_required', targetCents: null });
  expect(plan.issues.some(issue => issue.date === '2026-09-02')).toBe(true);
});

test('opposite daily money differences do not cancel each other to authorize range copying', () => {
  const scope = { ...filters, endDate: '2026-09-02' };
  const plan = build([order('ONE', scope.startDate, 100), order('TWO', scope.endDate, 200)],
    [fact(scope.startDate, 110, 1), fact(scope.endDate, 190, 1)], scope);
  expect(plan.varianceCents).toBe(0); expect(plan.columns).toBeNull();
  expect(plan.dailyReconciliation.map(day => day.varianceCents)).toEqual([-1000, 1000]);
});

test('opposite daily order-count differences cannot hide inside a matching range count and money', () => {
  const scope = { ...filters, endDate: '2026-09-02' };
  const plan = build([order('ONE', scope.startDate, 30), order('TWO', scope.endDate, 30), order('THREE', scope.endDate, 30)],
    [fact(scope.startDate, 30, 2), fact(scope.endDate, 60, 1)], scope);
  expect(plan.orderCount).toBe(plan.confirmedSales.orderCount); expect(plan.varianceCents).toBe(0);
  expect(plan.columns).toBeNull(); expect(plan.dailyReconciliation.every(day => day.status === 'review_required')).toBe(true);
});

test('range grand totals must also equal the independently retained daily BI money and counts', () => {
  const scope = { ...filters, endDate: '2026-09-02' };
  const facts = [fact(scope.startDate, 30, 1), fact(scope.endDate, 30, 1)];
  const confirmed = { ...summarizeConfirmedSales(facts, scope), salesTotal: 61, orderCount: 3 };
  const plan = buildAdaSmartCopyPlan([order('ONE', scope.startDate, 30), order('TWO', scope.endDate, 30)], confirmed, scope);
  expect(plan.columns).toBeNull();
  expect(plan.issues.some(issue => /รายวันรวม/u.test(issue.reason))).toBe(true);
});

test('Bangkok boundaries include the full start/end days and preserve Shopee support once', () => {
  const scope = { ...filters, endDate: '2026-09-02' };
  const orders = [order('FIRST', scope.startDate, 100, 1, { paidAt: '2026-08-31T17:00:00Z', shopeeProductDiscount: 1.01 }),
    order('LAST', scope.endDate, 20, 1, { paidAt: '2026-09-02T16:59:59Z' }),
    order('OUT', '2026-09-03', 99, 1, { paidAt: '2026-09-02T17:00:00Z' }),
    order('OTHER-SHOP', scope.startDate, 99, 1, { shopCode: 'dr-morepen' })];
  const plan = build(orders, [fact(scope.startDate, 101.01, 1), fact(scope.endDate, 20, 1)], scope);
  expect(plan).toMatchObject({ status: 'ready', orderCount: 2, merchandiseCents: 12000, supportCents: 101, totalCents: 12101 });
  expect(plan.rows[0].sources.map(source => source.orderNumber)).toEqual(['FIRST', 'LAST']);
});

test('verified corrections crossing range edges move order membership once and retain the required source proof', () => {
  const moved = order('MOVED', '2026-09-02', 30);
  const correction = { shopCode, orderNumber: moved.orderNumber, paidBusinessDate: '2026-09-02', businessDate: '2026-08-31',
    sourceFactFingerprint: sourceFactFingerprint(moved), enabled: true, verifiedBy: 'synthetic-reviewer', verifiedAt: '2026-10-01T00:00:00Z',
    evidence: { kind: 'daily_product_order_reconciliation', caseId: 'synthetic-boundary',
      sources: ['2026-08-31', '2026-09-02'].map(date => ({ date, reportType: 'shopee_confirmed_product_report',
        sourceFilename: `synthetic-${date}.xlsx`, sourceSha256: 'c'.repeat(64) })) } };
  const outside = build([moved], [fact('2026-09-01', 0, 0), fact('2026-09-02', 0, 0), fact('2026-09-03', 0, 0)], filters, [correction]);
  expect(outside).toMatchObject({ status: 'ready', orderCount: 0, totalCents: 0 });
  const scope = { ...filters, startDate: '2026-08-31', endDate: '2026-09-02' };
  const inside = build([moved], [fact('2026-08-31', 30, 1), fact('2026-09-01', 0, 0), fact('2026-09-02', 0, 0)], scope, [correction]);
  expect(inside).toMatchObject({ status: 'ready', orderCount: 1, totalQuantity: 1, totalCents: 3000 });
  expect(inside.rows[0].sources).toHaveLength(1); expect(inside.rows[0].sources[0].businessDate).toBe('2026-08-31');
  expect(build([moved], [fact('2026-09-01', 0, 0), fact('2026-09-02', 30, 1), fact('2026-09-03', 0, 0)], filters,
    [{ ...correction, sourceFactFingerprint: 'd'.repeat(64) }]).columns).toBeNull();
});

test('unknown products and duplicate source orders still block the entire range', () => {
  const first = order('ONE', filters.startDate, 30);
  const facts = [fact(filters.startDate, 30, 1), fact('2026-09-02', 0, 0), fact(filters.endDate, 0, 0)];
  expect(build([{ ...first, items: [{ name: 'UNKNOWN', variant: '', quantity: 1, unitPrice: 30 }] }], facts).columns).toBeNull();
  expect(build([first, first], facts).columns).toBeNull();
});
