const { HEADERS, parseSalesSourceRows } = require('../src/modules/seamless/services/shopeeSalesSourceService');
const { buildAdaSmartCopyPlan, resolveLineAmounts } = require('../src/modules/seamless/services/shopeeAdaSmartCopyService');
const filters = { shopCode: 'sc-drug-store', startDate: '2020-01-01', endDate: '2020-01-01' };
const options = { shopCode: filters.shopCode, sourceFilename: 'Order.all.20200101_20200101.xlsx',
  sourceSha256: 'a'.repeat(64), observedAt: '2020-01-02T00:00:00Z' };
const row = values => Object.keys(HEADERS).map(key => ({
  orderNumber: '200101LINE001', status: 'สำเร็จแล้ว', orderedAt: '2020-01-01 12:00',
  paidAt: '2020-01-01 12:01', completedAt: '-', voucherCodes: '-', sellerVoucher: 0,
  variant: '', quantity: 1, ...values,
})[key]);
const parsed = () => parseSalesSourceRows([Object.values(HEADERS),
  row({ name: 'A', unitPrice: 102, itemSubtotal: 102, shopeeProductDiscount: 1 }),
  row({ name: 'B', unitPrice: 19, itemSubtotal: 19, shopeeProductDiscount: 0 }),
], options).facts[0];
const order = () => ({ ...parsed(), sourceFilename: options.sourceFilename,
  sourceSha256: options.sourceSha256, observedAt: options.observedAt,
  items: parsed().items.map((item, index) => ({ ...item,
    productMatch: { status: 'matched', companySku: index ? '630010066' : 'IC-003143' },
  })),
});
const confirmed = { ...filters, status: 'source_backed', salesTotal: 122, orderCount: 1,
  shops: [{ shopCode: filters.shopCode, sources: [{ sourceFilename: 'synthetic-bi.xlsx', sourceSha256: 'b'.repeat(64) }] }],
};

test('original workbook cells survive parsing in item order without duplicating Shopee support', () => {
  const fact = parsed();
  expect(fact.lineFinancials).toEqual([
    { netSale: 102, shopeeProductDiscount: 1 }, { netSale: 19, shopeeProductDiscount: 0 },
  ]);
  expect(fact).toMatchObject({ itemSubtotal: 121, shopeeProductDiscount: 1, sourceRows: [2, 3] });
  expect(resolveLineAmounts(fact)).toMatchObject({ amounts: [10300, 1900], orderTotal: 12200, basis: 'source_line_components' });
});

test('copy includes both original product amounts when source line components are retained', () => {
  const input = order(); const before = JSON.stringify(input);
  const plan = buildAdaSmartCopyPlan([input], confirmed, filters);
  expect(plan.status).toBe('ready'); expect(plan.varianceCents).toBe(0);
  expect(plan.rows.map(item => [item.sku, item.quantity, item.amountCents])).toEqual([
    ['630010066', 1, 1900], ['IC-003143', 1, 10300],
  ]);
  expect(JSON.stringify(input)).toBe(before);
});

test.each([
  ['missing line', [{ netSale: 102, shopeeProductDiscount: 1 }]],
  ['null line', [null, { netSale: 19, shopeeProductDiscount: 0 }]],
  ['duplicated support', [{ netSale: 102, shopeeProductDiscount: 1 }, { netSale: 19, shopeeProductDiscount: 1 }]],
  ['changed net sale', [{ netSale: 101, shopeeProductDiscount: 1 }, { netSale: 19, shopeeProductDiscount: 0 }]],
])('invalid source financials (%s) keep all copy columns disabled', (_, lineFinancials) => {
  const plan = buildAdaSmartCopyPlan([{ ...order(), lineFinancials }], confirmed, filters);
  expect(plan.columns).toBeNull(); expect(plan.issues.length).toBeGreaterThan(0);
});

test('order seller vouchers remain unresolved across products, even with source merchandise cells', () => {
  expect(resolveLineAmounts({ ...parsed(), sellerVoucher: 10 }).reason).toMatch('ส่วนลดผู้ขาย');
});

test('single-product orders also reject mismatched recorded line components', () => {
  const one = { ...parsed(), items: [parsed().items[0]], itemSubtotal: 102,
    lineFinancials: [{ netSale: 101, shopeeProductDiscount: 1 }] };
  expect(resolveLineAmounts(one).reason).toMatch('ยอดรายสินค้าต้นทาง');
});
