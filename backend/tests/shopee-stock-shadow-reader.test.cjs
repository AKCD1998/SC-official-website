const { readShopeeStockShadow } = require('../src/modules/seamless/services/shopeeStockShadowReader');
function fixture({ failOrders = false, now = '2026-10-22T10:30:00Z', orders = [] } = {}) {
  const queries = [];
  const client = { release: jest.fn(), query: jest.fn(async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('transaction_timestamp')) return { rows: [{ captured_at: now }] };
    if (sql.includes('.shopee_orders')) { if (failOrders) throw new Error('private connection detail'); return { rows: orders }; }
    return { rows: [] };
  }) };
  return { client, queries, options: { pool: { connect: async () => client }, schema: 'synthetic_schema',
    posCatalog: [], from: '2026-09-15', now: () => new Date(now) } };
}
test('all source queries are bounded, branch/shop scoped and enclosed in a read-only snapshot', async () => {
  const f = fixture(); const result = await readShopeeStockShadow(f.options);
  expect(f.queries[0].sql).toBe('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  expect(f.queries.at(-1).sql).toBe('ROLLBACK'); expect(f.client.release).toHaveBeenCalledTimes(1);
  expect(f.queries.filter(q => /FROM /.test(q.sql)).every(q => q.params[0] === 'sc-drug-store')).toBe(true);
  expect(f.queries.find(q => q.sql.includes('.shopee_orders')).sql).toContain("AT TIME ZONE 'Asia/Bangkok'");
  expect(f.queries.every(q => !/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|CALL|COPY)\b/i.test(q.sql))).toBe(true);
  expect(result).toMatchObject({ status: 'PARTIAL', evidenceBasis: 'current-email-order-snapshot',
    eligibleForLiveStock: false, posIssueLinksInferredFromDryRunJobs: false,
    sellerCentreOnlyAndReportOnlyOrdersIncluded: false, historicalReconstructionSupported: false });
});
test('query failures still roll back and release without changing anything', async () => {
  const f = fixture({ failOrders: true });
  await expect(readShopeeStockShadow(f.options)).rejects.toMatchObject({ code: 'SHADOW_READ_FAILED', stage: 'orders', detailsWithheld: true });
  expect(f.queries.at(-1).sql).toBe('ROLLBACK'); expect(f.client.release).toHaveBeenCalledTimes(1);
});
test.each([['28P01', 'SHADOW_READ_ACCESS_DENIED'], ['ETIMEDOUT', 'SHADOW_READ_TIMEOUT']])
  ('connection failures expose only a stable safe code: %s', async (code, expected) => {
    const pool = { connect: async () => { throw Object.assign(new Error('private connection detail'), { code }); } };
    try {
      await readShopeeStockShadow({ ...fixture().options, pool }); throw new Error('expected failure');
    } catch (error) {
      expect(error).toMatchObject({ code: expected, stage: 'connect', detailsWithheld: true });
      expect(error.message).not.toContain('private connection detail');
    }
  });
test('a failed rollback destroys the client instead of returning an open transaction to the pool', async () => {
  const f = fixture(); const original = f.client.query;
  f.client.query = jest.fn((sql, ...args) => {
    if (sql === 'ROLLBACK') throw new Error('private transport detail');
    return original(sql, ...args);
  });
  await expect(readShopeeStockShadow(f.options)).rejects.toMatchObject({ code: 'SHADOW_ROLLBACK_FAILED', stage: 'rollback' });
  expect(f.client.release).toHaveBeenCalledWith(expect.objectContaining({ code: 'SHADOW_ROLLBACK_FAILED' }));
});
test('order truncation is a failure, not a complete audit', async () => {
  const f = fixture({ orders: [{}, {}] });
  await expect(readShopeeStockShadow({ ...f.options, limit: 1 })).rejects.toMatchObject({ code: 'SHADOW_ORDER_LIMIT' });
  expect(f.queries.at(-1).sql).toBe('ROLLBACK');
});
test('schema injection and invalid bounds are rejected before database access', async () => {
  const f = fixture();
  for (const change of [{ schema: 'bad;sql' }, { limit: 0 }, { limit: 20001 }, { from: 'yesterday' }]) {
    await expect(readShopeeStockShadow({ ...f.options, ...change })).rejects.toMatchObject({ code: 'SHADOW_READER_SCOPE_INVALID' });
  }
  expect(f.queries).toHaveLength(0);
});
test('database and client clock disagreement is surfaced instead of claiming an exact current snapshot', async () => {
  const f = fixture();
  await expect(readShopeeStockShadow({ ...f.options, now: () => new Date('2026-10-22T11:30:00Z') }))
    .rejects.toMatchObject({ code: 'SHADOW_CLOCK_UNCERTAIN' });
  expect(f.queries.at(-1).sql).toBe('ROLLBACK');
});
