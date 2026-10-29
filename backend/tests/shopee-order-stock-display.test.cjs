const { enrichOrderStockDisplay, getOrderStockSearchAliases } = require('../src/modules/seamless/services/shopeeOrderStockDisplay');
const order = { shopCode: 'sc-drug-store', items: [{ name: 'Synthetic', quantity: null,
  productMatch: { status: 'matched', companySku: 'ACCOUNTING-ONLY' }, unitPrice: null }] };

test('OFF and other shops do not load the stock store or read the database', async () => {
  const identityStore = { enrichOrdersForStockDisplay: jest.fn() };
  const orders = [order];
  expect(await enrichOrderStockDisplay(orders, { enabled: false, identityStore })).toBe(orders);
  expect(await enrichOrderStockDisplay([{ ...order, shopCode: 'dr-morepen' }], { enabled: true, identityStore })).toEqual([{ ...order, shopCode: 'dr-morepen' }]);
  expect(identityStore.enrichOrdersForStockDisplay).not.toHaveBeenCalled();
});

test('only an exact company SKU search reads verified aliases; failure is unavailable, not an empty success', async () => {
  const aliases = [{ productName: 'Synthetic exact package', variantName: '24 sachets' }];
  const identityStore = { stockSearchAliases: jest.fn(async () => aliases) };
  for (const search of ['Synthetic', '2026-10-29', '123', null]) {
    expect(await getOrderStockSearchAliases(search, { enabled: true, identityStore })).toEqual([]);
  }
  expect(await getOrderStockSearchAliases('IC-001510', { enabled: false, identityStore })).toEqual([]);
  expect(identityStore.stockSearchAliases).not.toHaveBeenCalled();
  expect(await getOrderStockSearchAliases('IC-001510', { enabled: true, identityStore })).toBe(aliases);
  identityStore.stockSearchAliases.mockRejectedValueOnce(Error('PRIVATE_PROVIDER_ERROR'));
  await expect(getOrderStockSearchAliases('630010038', { enabled: true, identityStore })).rejects.toMatchObject({
    statusCode: 503, code: 'STOCK_SEARCH_UNAVAILABLE', message: 'Stock SKU search is temporarily unavailable.',
  });
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
