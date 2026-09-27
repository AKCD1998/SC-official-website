jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
const pool = require('../db');
const { buildAdaSmartCopyPlan, resolveCopyProduct, resolveLineAmounts } = require('../src/modules/seamless/services/shopeeAdaSmartCopyService');
const { listPaidOrdersForCopy } = require('../src/modules/seamless/db/shopeeAdaSmartCopyRepository');
const { getAdaSmartCopySummary } = require('../src/modules/seamless/controllers/shopeeOrderController');
const filters = { shopCode: 'sc-drug-store', startDate: '2026-09-01', endDate: '2026-09-01' };
const source = { sourceFilename: 'Order.all.20260826_20260925.xlsx', sourceSha256: 'a'.repeat(64), observedAt: '2026-09-26T00:00:00Z' };
const item = (sku = '630010066', quantity = 1, unitPrice = 33) => ({ name: 'source product', variant: '', quantity, unitPrice,
  productMatch: { status: 'matched', companySku: sku } });
const order = (overrides = {}) => ({ ...source, shopCode: filters.shopCode, orderNumber: '260901TEST01',
  paidAt: '2026-09-01T01:00:00Z', items: [item()], sourceRows: [2],
  itemSubtotal: 33, shopeeProductDiscount: 0, sellerVoucher: 0, ...overrides });
const confirmed = (salesTotal = 33, orderCount = 1) => ({ ...filters, status: 'source_backed', salesTotal, orderCount,
  shops: [{ shopCode: filters.shopCode, sources: [source] }] });

test('paid Bangkok date defines cohort, including later cancellation and prior creation', () => {
  const plan = buildAdaSmartCopyPlan([
    order({ orderedAt: '2026-08-31T16:59:00Z', paidAt: '2026-08-31T17:00:00Z', excluded: true }),
    order({ orderNumber: '260902TEST02', paidAt: '2026-09-01T17:00:00Z' }),
    order({ shopCode: 'dr-morepen', orderNumber: '260901TEST03' }),
  ], confirmed(), filters);
  expect(plan.status).toBe('ready');
  expect(plan.orderCount).toBe(1);
  expect(plan.columns).toEqual({ sku: '630010066', quantity: '1', unitPrice: '33.00' });
});

test('Shopee-funded 63 baht belongs to the affected product exactly once', () => {
  const plan = buildAdaSmartCopyPlan([order({ items: [item('IC-003143', 1, 293)], itemSubtotal: 293,
    shopeeProductDiscount: 63 })], confirmed(356), filters);
  expect(plan.columns.unitPrice).toBe('356.00');
  expect(plan.supportCents).toBe(6300);
  expect(plan.totalCents).toBe(35600);
});

test('aggregate identical SKUs and preserve exact cents with high-price row first', () => {
  const plan = buildAdaSmartCopyPlan([order({ items: [item('630010066', 3)], itemSubtotal: '100.00' })], confirmed(100), filters);
  expect(plan.rows.map(row => [row.quantity, row.unitPrice])).toEqual([[1, '33.34'], [2, '33.33']]);
  expect(plan.columns.sku).toBe('630010066\n630010066');
  expect(plan.totalCents).toBe(10000);
});

test('multiple source unit prices allowed only with exact subtotal and no allocated discounts', () => {
  const multi = order({ items: [item('630010066', 2, 33), item('IC-003143', 1, 293)], sourceRows: [2, 3], itemSubtotal: 359 });
  expect(resolveLineAmounts(multi).amounts).toEqual([6600, 29300]);
  expect(resolveLineAmounts({ ...multi, itemSubtotal: 358 }).reason).toBeTruthy();
  expect(resolveLineAmounts({ ...multi, shopeeProductDiscount: 63 }).reason).toBeTruthy();
  expect(resolveLineAmounts({ ...multi, sellerVoucher: 10 }).reason).toBeTruthy();
  expect(resolveLineAmounts({ ...multi, shopeeProductDiscount: 63,
    lineFinancials: [{ netSale: 66, shopeeProductDiscount: 0 }, { netSale: 293, shopeeProductDiscount: 63 }] }).amounts)
    .toEqual([6600, 35600]);
});

test.each([
  ['missing Business Insights', undefined],
  ['different amount', confirmed(34)],
  ['different order count', confirmed(33, 2)],
  ['missing BI evidence', { ...confirmed(), shops: [{ shopCode: filters.shopCode, sources: [] }] }],
])('%s blocks every copy column', (_, bi) => {
  const plan = buildAdaSmartCopyPlan([order()], bi, filters);
  expect(plan.status).toBe('review_required');
  expect(plan.columns).toBeNull();
});

test('matching total alone does not waive missing SKU, source evidence or base-unit issues', () => {
  for (const changed of [
    order({ sourceRows: [] }), order({ sourceSha256: '' }),
    order({ items: [{ ...item(), productMatch: { status: 'unmapped' } }] }),
    order({ items: [{ ...item(), productMatch: { status: 'matched', companySku: 'IC-003778', quantityUnit: 'box' }, variant: 'ชมพู 1 กล่อง' }] }),
    order({ items: [{ ...item(), productMatch: { status: 'matched', companySku: '630010066', quantityPerSale: 6 } }] }),
  ]) expect(buildAdaSmartCopyPlan([changed], confirmed(), filters).columns).toBeNull();
});

test('SC004 exact user SKU consolidation keeps original price and source variant', () => {
  const changed = { ...item(), name: '1 ซอง Strepsils HHR ยาอมบรรเทาอาการเจ็บคอ 8 เม็ด',
    variant: 'เลมอน ไม่มีน้ำตาล', productMatch: { status: 'unmapped' } };
  expect(resolveCopyProduct('sc-drug-store', changed).sku).toBe('630010066');
  expect(resolveCopyProduct('dr-morepen', changed).reason).toBeTruthy();
  const plan = buildAdaSmartCopyPlan([order({ items: [changed] }), order({ orderNumber: '260901TEST02',
    items: [item('630010066', 2)], itemSubtotal: 66 })], confirmed(99, 2), filters);
  expect(plan.columns).toEqual({ sku: '630010066', quantity: '3', unitPrice: '33.00' });
  expect(plan.rows[0].sources[0].variant).toBe('เลมอน ไม่มีน้ำตาล');
});

test('verified Oreda packaging uses ten ERP sachets, not one 10Pcs item', () => {
  const changed = { ...item('IC-004371'), name: '10 ซอง Oreda RO ผงเกลือแร่ รสส้ม 5.5 กรัม บรรเทาอาการท้องเสีย', variant: '10Pcs' };
  const plan = buildAdaSmartCopyPlan([order({ items: [changed], itemSubtotal: 21 })], confirmed(21), filters);
  expect(plan.columns).toEqual({ sku: 'IC-004371', quantity: '10', unitPrice: '2.10' });
});

test('repository uses source products and paid-date bounds after snapshot selection, no cancellation exclusion', async () => {
  pool.query.mockResolvedValueOnce({ rows: [] });
  await listPaidOrdersForCopy(filters);
  const [sql, values] = pool.query.mock.calls.at(-1);
  expect(values).toEqual(['sc-drug-store', '2026-09-01', '2026-09-01']);
  expect(sql).toContain("AT TIME ZONE 'Asia/Bangkok'");
  expect(sql.indexOf('SELECT * FROM latest')).toBeLessThan(sql.indexOf('WHERE paid_at'));
  expect(sql).not.toMatch(/UPDATE|INSERT|DELETE|excluded =|shopee_orders\b/u);
});

test('financial copy endpoint rejects non-admins and aggregate scopes before queries', async () => {
  await expect(getAdaSmartCopySummary({ appRole: 'viewer', query: filters }, {})).rejects.toMatchObject({ statusCode: 403 });
  await expect(getAdaSmartCopySummary({ appRole: 'admin', query: { ...filters, shopCode: 'all' } }, {})).rejects.toMatchObject({ statusCode: 400 });
  await expect(getAdaSmartCopySummary({ appRole: 'admin', query: { ...filters, endDate: '2026-09-02' } }, {})).rejects.toMatchObject({ statusCode: 400 });
});
