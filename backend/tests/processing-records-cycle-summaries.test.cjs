const queryMock = jest.fn();

jest.mock('../db', () => ({
  query: (...args) => queryMock(...args),
}));

const {
  listShopeeAccountingCycleSummaries,
} = require('../src/modules/seamless/processingRecords');

beforeEach(() => {
  jest.clearAllMocks();
});

test('loads every distinct Shopee cycle summary without a history-page limit', async () => {
  queryMock.mockResolvedValue({
    rows: [
      {
        checkpoint_eligible: 'true',
        cycle_closure_status: 'ready_with_rows',
        final_rows: '46',
        period_end: '2026-07-26',
        period_start: '2026-06-29',
        row_count: '46',
      },
    ],
  });

  const summaries = await listShopeeAccountingCycleSummaries();

  expect(summaries).toEqual([
    {
      checkpointEligible: 'true',
      cycleClosureStatus: 'ready_with_rows',
      finalRows: '46',
      periodEnd: '2026-07-26',
      periodStart: '2026-06-29',
      rowCount: '46',
    },
  ]);
  const [sql, params] = queryMock.mock.calls[0];
  expect(sql).toMatch(/SELECT DISTINCT/);
  expect(sql).toMatch(/report_type = 'shopee'/);
  expect(sql).not.toMatch(/\bLIMIT\b/);
  expect(params).toBeUndefined();
});
