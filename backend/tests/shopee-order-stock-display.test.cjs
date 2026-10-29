const { enrichOrderStockDisplay } = require('../src/modules/seamless/services/shopeeOrderStockDisplay');
const order = { shopCode: 'sc-drug-store', items: [{ name: 'Synthetic', quantity: null,
  productMatch: { status: 'matched', companySku: 'ACCOUNTING-ONLY' }, unitPrice: null }] };

test('OFF and other shops do not load the stock store or read the database', async () => {
  const identityStore = { enrichOrdersForStockDisplay: jest.fn() };
  const orders = [order];
  expect(await enrichOrderStockDisplay(orders, { enabled: false, identityStore })).toBe(orders);
  expect(await enrichOrderStockDisplay([{ ...order, shopCode: 'dr-morepen' }], { enabled: true, identityStore })).toEqual([{ ...order, shopCode: 'dr-morepen' }]);
  expect(identityStore.enrichOrdersForStockDisplay).not.toHaveBeenCalled();
});

test('an unavailable stock read remains unknown and preserves orders, prices and accounting matching', async () => {
  const reportFailure = jest.fn(), identityStore = { enrichOrdersForStockDisplay: async () => { throw Error('PRIVATE_DETAILS'); } };
  const orders = [order, { ...order, shopCode: 'dr-morepen' }];
  const result = await enrichOrderStockDisplay(orders, { enabled: true, identityStore, reportFailure });
  expect(result[0].items[0].stockProductMatch).toEqual({ status: 'unavailable', branchCode: '004', components: [] });
  expect(result[0].items[0].quantity).toBeNull();
  expect(result[0].items[0].unitPrice).toBeNull();
  expect(result[0].items[0].productMatch).toBe(order.items[0].productMatch);
  expect(result[1]).toBe(orders[1]);
  expect(order.items[0].stockProductMatch).toBeUndefined();
  expect(reportFailure).toHaveBeenCalledWith();
  expect(JSON.stringify(result)).not.toContain('PRIVATE_DETAILS');
});
