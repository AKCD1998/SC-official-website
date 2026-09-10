const query = jest.fn(async (sql, params) => {
  if (/WITH scoped_orders/iu.test(sql)) return { rows: [{
    shop_code: 'sc-drug-store', order_number: '260831TEST001',
    ordered_at: new Date('2026-08-20T10:00:00.000Z'), paid_at: new Date('2026-08-31T16:00:00.000Z'),
    completed_at: null, status: 'สำเร็จแล้ว', excluded: false,
    item_subtotal: '100.00', seller_voucher: '0.00', shopee_product_discount: '0.00',
    voucher_codes: ['SVC-1489610191827020'],
    source_rows: [2], source_sha256: 'a'.repeat(64), source_filename: 'Order.all.20260801_20260831.xlsx',
    observed_at: new Date('2026-09-10T00:00:00.000Z'), start_date: '2026-08-01', end_date: '2026-08-31',
    order_count: 1, imported_at: new Date('2026-09-10T00:00:00.000Z'),
  }] };
  if (/FROM .*shopee_sales_sources[\s\S]*WHERE shop_code/iu.test(sql)) return { rows: [] };
  if (/report_type = 'return-refund-cancel'/iu.test(sql)) return { rows: [] };
  if (/FROM .*shopee_seller_voucher_evidence/iu.test(sql)) {
    expect(params.slice(1)).toEqual(['2026-08-31', '2026-08-31']);
    return { rows: [{
    shop_code: 'sc-drug-store', voucher_id: 'SVC-1489610191827020', voucher_name: 'VCMT BAU 24-30 Aug',
    valid_from: new Date('2026-08-23T17:00:00.000Z'), valid_to: new Date('2026-08-30T16:59:59.999Z'),
    discount_rate: '0.05000000', max_discount: '10.00', min_spend: '110.00', applies_to_all_products: true,
    source_url: 'https://seller.shopee.co.th/portal/marketing/vouchers/view?edit=1489610191827020',
    source_observed_at: new Date('2026-09-09T17:00:00.000Z'), source_observed_precision: 'date',
    source_notes: 'Seller Centre voucher detail.', recorded_by: 'accounting-review',
    recorded_at: new Date('2026-09-10T00:00:00.000Z'),
    }] };
  }
  if (/FROM .*shopee_income_facts/iu.test(sql)) return { rows: [{
    shop_code: 'sc-drug-store', order_number: '260831TEST001', return_request_number: null,
    ordered_at: new Date('2026-08-31T10:00:00.000Z'), payout_amount: '80.00', components: {},
    transferred_at: new Date('2026-09-02T00:00:00.000Z'), source_row: 7,
    report_type: 'income-transferred', source_sha256: 'b'.repeat(64), source_filename: 'income.xlsx',
    observed_at: new Date('2026-09-10T00:00:00.000Z'), start_date: '2026-09-01', end_date: '2026-09-07',
  }] };
  if (/FROM .*shopee_seller_balance_facts/iu.test(sql) || /FROM .*shopee_return_facts/iu.test(sql)) return { rows: [] };
  if (/LEFT JOIN .*shopee_financial_statement_facts/iu.test(sql)) {
    expect(params[3]).toContain('sc-drug-store:2026-09-01:2026-09-07');
    return { rows: [
      { shop_code: 'sc-drug-store', report_type: 'financial-statement', source_sha256: 'c'.repeat(64),
        source_filename: 'weekly_report_20260901.pdf', observed_at: new Date('2026-09-10T00:00:00.000Z'),
        start_date: '2026-09-01', end_date: '2026-09-07', source_row_count: 1, control: {},
        imported_at: new Date('2026-09-10T00:00:00.000Z'), transferred_total: '80.00', page_count: 1 },
      { shop_code: 'sc-drug-store', report_type: 'seller-balance', source_sha256: 'd'.repeat(64),
        source_filename: 'unrelated-balance.xlsx', observed_at: new Date('2026-09-10T00:00:00.000Z'),
        start_date: '2026-08-25', end_date: '2026-08-31', source_row_count: 1,
        control: { adjustmentTotal: 0, adjustmentCount: 0 }, imported_at: new Date('2026-09-10T00:00:00.000Z') },
    ] };
  }
  throw new Error(`Unhandled SQL: ${sql}`);
});

jest.mock('../db', () => ({ query: (...args) => query(...args) }));

const { listReconciliationEvidence } = require('../src/modules/seamless/db/shopeeFinancialReconciliationRepository');

test('a sale paid Aug 31 loads downstream controls from its linked Sep 1-7 Income cycle', async () => {
  const result = await listReconciliationEvidence({
    shopCode: 'sc-drug-store', startDate: '2026-08-31', endDate: '2026-08-31',
  });
  expect(result.incomeFacts[0]).toMatchObject({ sourceStartDate: '2026-09-01', sourceEndDate: '2026-09-07' });
  expect(result.orderSnapshots[0].voucherCodes).toEqual(['SVC-1489610191827020']);
  expect(result.sellerVoucherEvidence).toMatchObject([{
    voucherId: 'SVC-1489610191827020', discountRate: 0.05, maxDiscount: 10, minSpend: 110,
    sourceObservedPrecision: 'date',
  }]);
  expect(result.downstreamControls.financialStatements).toMatchObject([{
    startDate: '2026-09-01', endDate: '2026-09-07', linkedIncomeCycle: true, transferredTotal: 80,
  }]);
  expect(result.downstreamControls.unlinkedSources).toMatchObject([{
    reportType: 'seller-balance', startDate: '2026-08-25', endDate: '2026-08-31', linkedIncomeCycle: false,
  }]);
  const orderSourcesSql = query.mock.calls.map(([sql]) => sql)
    .find((sql) => /FROM .*shopee_sales_sources/iu.test(sql) && /OR EXISTS/iu.test(sql));
  expect(orderSourcesSql).toMatch(/FROM\s+"[^"]+"\."shopee_sales_sources"\s+s\s+WHERE/iu);
  expect(orderSourcesSql).toMatch(/fact\.shop_code\s*=\s*s\.shop_code/iu);
  expect(orderSourcesSql).toMatch(/fact\.source_sha256\s*=\s*s\.source_sha256/iu);
});
