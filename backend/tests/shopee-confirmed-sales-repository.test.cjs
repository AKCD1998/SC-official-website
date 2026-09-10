jest.mock('../db', () => ({ query: jest.fn() }));

const pool = require('../db');
const {
  listConfirmedSalesDays,
} = require('../src/modules/seamless/db/shopeeConfirmedSalesRepository');

beforeEach(() => {
  jest.clearAllMocks();
});

test('a newer thin Sales Overview cannot erase cancellation and return evidence from a complete report', async () => {
  pool.query.mockResolvedValueOnce({ rows: [{
    shop_code: 'sc-drug-store',
    report_date: '2026-08-25',
    sales_total: '15896.00',
    order_count: '46',
    cancelled_sales: '2621.00',
    cancelled_order_count: '6',
    returned_sales: '0.00',
    returned_order_count: '0',
    source_row: 605,
    source_filename: 'sales_overview_20260801-20260831.xlsx',
    source_sha256: 'a'.repeat(64),
    observed_at: new Date('2026-09-10T05:21:14.502Z'),
    imported_at: new Date('2026-09-10T05:22:00.000Z'),
    cancellations_source_row: 29,
    cancellations_source_filename: '142wuxqhgi.shopee-shop-stats.20260801-20260831.xlsx',
    cancellations_source_sha256: 'b'.repeat(64),
    cancellations_observed_at: new Date('2026-09-08T04:11:47.000Z'),
    cancellations_imported_at: new Date('2026-09-08T04:12:00.000Z'),
    returns_source_row: 29,
    returns_source_filename: '142wuxqhgi.shopee-shop-stats.20260801-20260831.xlsx',
    returns_source_sha256: 'b'.repeat(64),
    returns_observed_at: new Date('2026-09-08T04:11:47.000Z'),
    returns_imported_at: new Date('2026-09-08T04:12:00.000Z'),
  }] });

  const result = await listConfirmedSalesDays({
    shopCode: 'sc-drug-store', startDate: '2026-08-25', endDate: '2026-08-25',
  });

  expect(result[0]).toMatchObject({
    salesTotal: 15896,
    orderCount: 46,
    cancelledSales: 2621,
    cancelledOrderCount: 6,
    returnedSales: 0,
    returnedOrderCount: 0,
    sourceFilename: 'sales_overview_20260801-20260831.xlsx',
    metricEvidence: {
      confirmedSales: { sourceSha256: 'a'.repeat(64), sourceRow: 605 },
      cancellations: { sourceSha256: 'b'.repeat(64), sourceRow: 29 },
      returns: { sourceSha256: 'b'.repeat(64), sourceRow: 29 },
    },
  });

  const [sql, params] = pool.query.mock.calls[0];
  expect(params).toEqual(['sc-drug-store', '2026-08-25', '2026-08-25']);
  expect(sql).toMatch(/latest_cancellations[\s\S]*cancelled_sales IS NOT NULL AND cancelled_order_count IS NOT NULL/iu);
  expect(sql).toMatch(/latest_returns[\s\S]*returned_sales IS NOT NULL AND returned_order_count IS NOT NULL/iu);
  expect(sql).toMatch(/LEFT JOIN latest_cancellations/iu);
  expect(sql).toMatch(/LEFT JOIN latest_returns/iu);
});

