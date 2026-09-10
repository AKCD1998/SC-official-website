const result = { status: 'reconciled', timezone: 'Asia/Bangkok' };
const getMock = jest.fn(async () => result);

jest.mock('../src/modules/seamless/services/shopeeFinancialReconciliationService', () => ({
  getShopeeFinancialReconciliation: (...args) => getMock(...args),
}));

const { getSalesReconciliation } = require('../src/modules/seamless/controllers/shopeeOrderController');

function response() {
  return { set: jest.fn(), json: jest.fn() };
}

test('financial reconciliation API is admin-only and preserves arbitrary inclusive filters', async () => {
  const denied = response();
  await expect(getSalesReconciliation({ appRole: 'user', query: {
    shopCode: 'all', startDate: '2026-08-01', endDate: '2026-08-31',
  } }, denied)).rejects.toMatchObject({ statusCode: 403 });
  expect(getMock).not.toHaveBeenCalled();

  const allowed = response();
  await getSalesReconciliation({ appRole: 'admin', query: {
    shopCode: 'sc-drug-store', startDate: '2026-08-25', endDate: '2026-09-02',
  } }, allowed);
  expect(getMock).toHaveBeenCalledWith({
    shopCode: 'sc-drug-store', startDate: '2026-08-25', endDate: '2026-09-02',
  });
  expect(allowed.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
  expect(allowed.json).toHaveBeenCalledWith(result);
});
