const { createShopee004StockLedger } = require('../src/modules/seamless/services/shopee004StockLedger');

// Measure returned application data, not SQL text or a guessed billing meter.
// A production-sized control document must not cross the connection on idle polls.
function idleFixture(mode = 'live') {
  const control = {
    mode, cutover_at: new Date('2026-10-23T06:26:56Z'),
    plan: { opening: [], legacyOrders: [], padding: 'x'.repeat(245000) },
    pos_catalog: [{ companySku: 'P1', padding: 'x'.repeat(64000) }],
  };
  let returnedBytes = 0;
  const raw = {
    release: jest.fn(),
    query: jest.fn(async ({ text }) => {
      let rows = [];
      if (text.includes('FROM "synthetic".shopee004_stock_control')) {
        rows = [text.includes('pos_catalog') || /SELECT \*/.test(text)
          ? control : text.includes('cutover_at')
            ? { mode: control.mode, cutover_at: control.cutover_at } : { mode: control.mode }];
      }
      returnedBytes += Buffer.byteLength(JSON.stringify(rows));
      return { rows };
    }),
  };
  const provider = jest.fn(async () => { throw Error('Unused mapper must not load'); });
  const ledger = createShopee004StockLedger({ pool: { connect: async () => raw },
    schema: 'synthetic', enabled: true, mappingContextProvider: provider });
  return { ledger, raw, provider, bytes: () => returnedBytes };
}

test('120 empty worker polls return under 8 KiB instead of repeatedly loading a 300 KiB plan/catalog', async () => {
  const f = idleFixture();
  for (let i = 0; i < 120; i++) expect(await f.ledger.processOne()).toBe(false);
  expect(f.bytes()).toBeLessThan(8192);
  expect(f.provider).not.toHaveBeenCalled();
  expect(f.raw.release).toHaveBeenCalledTimes(120);
});

test('empty mapping recovery returns under 1 KiB and never builds an unused identity snapshot', async () => {
  const f = idleFixture();
  expect(await f.ledger.requeueResolvedMappings()).toEqual({ queuedOrders: 0 });
  expect(f.bytes()).toBeLessThan(1024);
  expect(f.provider).not.toHaveBeenCalled();
});

test('unactivated worker does not claim queued work or load a mapping snapshot', async () => {
  const f = idleFixture('planned');
  expect(await f.ledger.processOne()).toBe(false);
  expect(f.raw.query.mock.calls.some(([q]) => q.text.includes('shopee004_stock_dirty'))).toBe(false);
  expect(f.provider).not.toHaveBeenCalled();
});
