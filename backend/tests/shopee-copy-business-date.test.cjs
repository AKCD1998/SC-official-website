jest.mock('../db', () => ({ query: jest.fn() }));
const pool = require('../db');
const { getOrdersForCopyCohort } = require('../src/modules/seamless/db/shopeeAdaSmartCopyRepository');
const { sourceFactFingerprint, selectCopyCohort } = require('../src/modules/seamless/services/shopeeCopyBusinessDate');
const { buildAdaSmartCopyPlan } = require('../src/modules/seamless/services/shopeeAdaSmartCopyService');
const shopCode = 'sc-drug-store';
const filters = date => ({ shopCode, startDate: date, endDate: date });
const first = filters('2020-01-01'); const second = filters('2020-01-02');
const order = (orderNumber, paidAt = '2020-01-01T17:05:00Z', overrides = {}) => ({
  shopCode, orderNumber, paidAt, orderedAt: '2020-01-01T13:05:00Z',
  itemSubtotal: '30.00', sellerVoucher: '0.00', shopeeProductDiscount: '0.00',
  items: [{ name: 'Synthetic product', variant: '', quantity: 2, unitPrice: 15,
    productMatch: { status: 'matched', companySku: '630010066' } }],
  sourceRows: [2], sourceSha256: 'a'.repeat(64), sourceFilename: 'synthetic-orders.xlsx',
  observedAt: '2020-01-03T00:00:00Z', ...overrides,
});
const moved = ['200101TESTB01','200101TESTB02','200101TESTB03'].map(id => order(id));
const evidence = { kind: 'daily_product_order_reconciliation', caseId: 'synthetic-test',
  sources: [first, second].map(f => ({ date: f.startDate, reportType: 'shopee_confirmed_product_report',
    sourceFilename: `synthetic-${f.startDate}.xlsx`, sourceSha256: 'b'.repeat(64) })) };
const correction = o => ({ shopCode, orderNumber:o.orderNumber, paidBusinessDate:second.startDate,
  businessDate:first.startDate, sourceFactFingerprint:sourceFactFingerprint(o),
  evidence, verifiedAt:'2020-01-03T01:00:00Z', verifiedBy:'synthetic-reviewer', enabled:true });
const corrections = moved.map(correction);
const normal = [order('200101NORMAL1', '2020-01-01T01:00:00Z'), order('200102NORMAL2')];
const source = [...normal, ...moved];
const confirmed = (f, cents, count) => ({ ...f, status:'source_backed', salesTotal:cents / 100,
  orderCount:count, shops:[{ shopCode, sources:[{ sourceSha256:'c'.repeat(64), sourceFilename:'synthetic-bi.xlsx' }] }] });
const plan = (f, cents, count, orders = source, rules = corrections) =>
  buildAdaSmartCopyPlan(orders, confirmed(f,cents,count),f,rules);

test('verified order membership moves once across both days, preserving all prices and quantities', () => {
  const before = JSON.stringify(source);
  const p1 = plan(first,12000,4); const p2 = plan(second,3000,1);
  expect(p1.status).toBe('ready'); expect(p2.status).toBe('ready');
  expect(p1.columns).toEqual({ sku:'630010066', quantity:'8', unitPrice:'15.00' });
  expect(p2.columns).toEqual({ sku:'630010066', quantity:'2', unitPrice:'15.00' });
  const included = [p1,p2].flatMap(p => p.rows[0].sources.map(s => s.orderNumber));
  expect(new Set(included).size).toBe(5); expect(included).toHaveLength(5);
  expect(p1.totalCents + p2.totalCents).toBe(15000);
  expect(p1.totalQuantity + p2.totalQuantity).toBe(10);
  expect(p1.businessDateCorrections).toHaveLength(3);
  expect(p2.businessDateCorrections.every(c => c.applied)).toBe(true);
  expect(p1.rows[0].sources.filter(s => s.dateBasis === 'verified_business_date')).toHaveLength(3);
  expect(JSON.stringify(source)).toBe(before);
});

test('same creation day, same product and another shop do not inherit a case correction', () => {
  const unrelated = order('200101OTHER01');
  const result = selectCopyCohort([...source, unrelated, { ...moved[0], shopCode:'dr-morepen' }], corrections, first);
  expect(result.orders.map(o => o.orderNumber)).not.toContain(unrelated.orderNumber);
  expect(result.orders.every(o => o.shopCode === shopCode)).toBe(true);
  const other = selectCopyCohort([{ ...moved[0], shopCode:'dr-morepen' }], corrections,
    { ...second, shopCode:'dr-morepen' });
  expect(other.orders[0].copyDateBasis).toBe('paid_at');
});

test.each([
  ['paid time', { paidAt:'2020-01-02T17:05:00Z' }],
  ['creation time', { orderedAt:'2020-01-01T12:05:00Z' }],
  ['merchandise', { itemSubtotal:31 }], ['seller discount', { sellerVoucher:1 }],
  ['Shopee support', { shopeeProductDiscount:1 }],
  ['quantity', { items:[{ ...moved[0].items[0], quantity:3 }] }],
  ['unit price', { items:[{ ...moved[0].items[0], unitPrice:14 }] }],
  ['identity', { items:[{ ...moved[0].items[0], name:'Different product' }] }],
  ['variant', { items:[{ ...moved[0].items[0], variant:'Different pack' }] }],
])('changed %s blocks copying on both dates even with matching BI aggregates', (_, change) => {
  const changed = source.map(o => o.orderNumber === moved[0].orderNumber ? { ...o,...change } : o);
  for (const f of [first,second]) {
    const p = plan(f,9000,3,changed);
    expect(p.columns).toBeNull();
    expect(p.issues.some(i => /ข้อมูลต้นทางเปลี่ยน/u.test(i.reason))).toBe(true);
  }
});

test('a missing source order blocks both affected days rather than disappearing from the correction audit', () => {
  const changed = source.filter(o => o.orderNumber !== moved[0].orderNumber);
  for (const f of [first,second]) {
    const p = plan(f,9000,3,changed);
    expect(p.columns).toBeNull();
    expect(p.businessDateCorrections.find(c => c.orderNumber === moved[0].orderNumber).applied).toBe(false);
  }
});

test.each([
  ['no source evidence', { evidence:{ ...evidence,sources:[] } }],
  ['missing opposite-day report', { evidence:{ ...evidence,sources:evidence.sources.slice(0,1) } }],
  ['unsupported evidence', { evidence:{ ...evidence,kind:'matching_total_only' } }],
  ['missing verifier', { verifiedBy:'' }], ['bad date', { businessDate:'2020-02-30' }],
])('%s never authorizes a correction', (_, change) => {
  const p = plan(first,12000,4,source,[{ ...corrections[0],...change },...corrections.slice(1)]);
  expect(p.status).toBe('review_required'); expect(p.columns).toBeNull();
});

test('new immutable import metadata and later cancellation do not invalidate identical source facts', () => {
  const replay = source.map(o => ({ ...o, sourceRows:[81], sourceSha256:'d'.repeat(64),
    sourceFilename:'later-orders.xlsx', observedAt:'2020-01-04T01:00:00Z', status:'cancelled', excluded:true,
    items:o.items.map(i => ({ ...i, unitPrice:'15.00' })), itemSubtotal:30 }));
  expect(plan(first,12000,4,replay).status).toBe('ready');
});

test('duplicate corrections and duplicate selected orders block all copy columns', () => {
  expect(plan(first,12000,4,source,[...corrections,corrections[0]]).columns).toBeNull();
  expect(plan(first,12000,4,[...source,moved[0]]).columns).toBeNull();
});

test('an unrelated date and a disabled correction retain the paid-date selection', () => {
  const third = filters('2020-01-03');
  expect(selectCopyCohort([order('200103TEST01','2020-01-03T01:00:00Z')],corrections,third).corrections).toEqual([]);
  expect(selectCopyCohort([moved[0]],[{ ...corrections[0],enabled:false }],first).orders).toEqual([]);
  expect(selectCopyCohort([moved[0]],[],second).orders).toHaveLength(1);
});

test('repository reads both sides and missing candidates from one latest-source snapshot without mutating facts', async () => {
  const raw = { shop_code:shopCode, order_number:moved[0].orderNumber, items:moved[0].items,
    paid_at:moved[0].paidAt, ordered_at:moved[0].orderedAt, source_sha256:'a'.repeat(64) };
  pool.query.mockResolvedValueOnce({ rows:[{ orders:[raw], corrections }] });
  const result = await getOrdersForCopyCohort(first);
  expect(result.orders[0]).toMatchObject({ shopCode, orderNumber:moved[0].orderNumber });
  expect(result.businessDateCorrections).toEqual(corrections);
  const [sql,values] = pool.query.mock.calls.at(-1);
  expect(values).toEqual([shopCode,first.startDate,first.endDate]);
  expect(sql).toContain('paid_business_date BETWEEN');
  expect(sql).toContain('business_date BETWEEN');
  expect(sql).toContain('OR order_number IN (SELECT order_number FROM corrections)');
  expect(sql.indexOf('DISTINCT ON')).toBeLessThan(sql.indexOf('WHERE (paid_at'));
  expect(sql).not.toMatch(/UPDATE|INSERT|DELETE|excluded =/u);
});
