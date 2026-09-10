const { enrichIncomeComponents } = require('../src/modules/seamless/db/shopeeOfficialDocumentRepository');

const tables = { shopeeIncomeFacts: 'test.shopee_income_facts' };
const source = {
  shopCode: 'sc-drug-store',
  sourceSha256: 'a'.repeat(64),
  reportType: 'income-transferred',
  facts: [{
    sourceRow: 7,
    orderNumber: '260901TEST001',
    returnRequestNumber: null,
    orderedAt: '2026-08-31T17:00:00.000Z',
    transferredAt: '2026-09-01T17:00:00.000Z',
    payoutAmount: 100,
    components: {
      productRegularAmount: 140,
      sellerProductDiscount: -10,
      buyerRefund: 0,
      shopeeProductDiscount: -20,
      sellerVoucher: -10,
      commissionFee: null,
      additiveTotal: 100,
      unexplainedResidual: 0,
      reconciliationStatus: 'reconciled',
    },
  }],
};

function existing(components = {
  productRegularAmount: 140,
  sellerProductDiscount: -10,
  buyerRefund: 0,
  shopeeProductDiscount: -20,
  sellerVoucher: -10,
}) {
  return {
    source_row: 7,
    order_number: '260901TEST001',
    return_request_number: null,
    ordered_at: new Date('2026-08-31T17:00:00.000Z'),
    transferred_at: new Date('2026-09-01T17:00:00.000Z'),
    payout_amount: '100.00',
    components,
  };
}

test('exact-source replay enriches only missing Income component keys without duplicating facts', async () => {
  const queries = [];
  const client = { query: jest.fn(async (sql, params) => {
    queries.push({ sql, params });
    if (/SELECT source_row/iu.test(sql)) return { rows: [existing()] };
    return { rows: [] };
  }) };
  await enrichIncomeComponents(client, tables, source);
  expect(queries).toHaveLength(2);
  expect(queries[1].sql).toMatch(/^\s*UPDATE test\.shopee_income_facts/iu);
  const [update] = JSON.parse(queries[1].params[2]);
  expect(update).toMatchObject({
    source_row: 7,
    components: {
      productRegularAmount: 140,
      sellerVoucher: -10,
      commissionFee: null,
      additiveTotal: 100,
      unexplainedResidual: 0,
      reconciliationStatus: 'reconciled',
    },
  });
  expect(queries.some(({ sql }) => /INSERT|DELETE/iu.test(sql))).toBe(false);
});

test('Income enrichment is write-free when complete and rejects an existing component conflict', async () => {
  const completeClient = { query: jest.fn(async () => ({ rows: [existing(source.facts[0].components)] })) };
  await enrichIncomeComponents(completeClient, tables, source);
  expect(completeClient.query).toHaveBeenCalledTimes(1);

  const conflictClient = { query: jest.fn(async () => ({
    rows: [existing({ ...source.facts[0].components, sellerVoucher: -9 })],
  })) };
  await expect(enrichIncomeComponents(conflictClient, tables, source))
    .rejects.toThrow(/immutable My Income component differs/iu);
  expect(conflictClient.query).toHaveBeenCalledTimes(1);
});
