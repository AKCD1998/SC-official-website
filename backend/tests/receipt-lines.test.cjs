const { normalizeReceiptItems } = require('../lib/receiptLines');
const { receiptEligibleAmount } = require('../lib/sccrmPromotions');
const { buildReceiptSnapshot, mapPurchase } = require('../lib/purchaseHistory');
const { saleWithItemVoid } = require('./fixtures/ada-item-void.cjs');

test('full item removal preserves the later re-added same SKU and original sequence/unit/quantity', () => {
  const raw = saleWithItemVoid(), before = JSON.stringify(raw);
  const result = normalizeReceiptItems(raw);
  expect(result.items).toMatchObject([{ seq: 3, qty: 2, lineTotal: 90 }, { seq: 4, qty: 1, lineTotal: 85 }]);
  expect(result.items.map(i => i.unitName)).toEqual(['ขวด', 'ขวด']);
  expect(receiptEligibleAmount(result.items)).toBe(175);
  expect(result.lineAdjustments).toMatchObject({ policy: 'ada-exact-item-void-pairs', pairs: [{ originalSeq: 1, voidSeq: 2 }] });
  expect(result.lineAdjustments.sourceItems).toHaveLength(4);
  expect(JSON.stringify(raw)).toBe(before);
});

test('customer history contains actual purchases and never exposes private source/audit metadata', () => {
  const { items, lineAdjustments } = normalizeReceiptItems(saleWithItemVoid());
  const snapshot = { ...buildReceiptSnapshot({ receiptTotalAmount: 175, posCode: '001' }, items), lineAdjustments };
  const history = mapPurchase({ receipt_snapshot: snapshot, total_amount: 175, receipt_total_amount: 175 }, [], []);
  expect(history.items.map(i => i.seq)).toEqual([3, 4]);
  expect(history.totalAmount).toBe(175);
  expect(history).not.toHaveProperty('lineAdjustments');
  expect(history).not.toHaveProperty('sourceItems');
});

test('multiple removals and repeated identical items consume exactly one preceding match each', () => {
  const [original, reversal, sold] = saleWithItemVoid();
  const input = [original, { ...original, seq: 2 }, { ...reversal, seq: 3 }, { ...reversal, seq: 4 }, { ...sold, seq: 5 }];
  const result = normalizeReceiptItems(input);
  expect(result.items.map(i => i.seq)).toEqual([5]);
  expect(result.lineAdjustments.pairs).toEqual([{ originalSeq: 2, voidSeq: 3 }, { originalSeq: 1, voidSeq: 4 }]);
});

test('zero-priced items can be sold or removed without inventing a purchase', () => {
  const [original, reversal, sold] = saleWithItemVoid();
  const result = normalizeReceiptItems([{ ...original, unitPrice: 0, lineTotal: 0 }, { ...reversal, unitPrice: 0, lineTotal: 0 }, sold]);
  expect(result.items).toHaveLength(1); expect(receiptEligibleAmount(result.items)).toBe(90);
  const free = [{ ...sold, unitPrice: 0, lineTotal: 0 }];
  expect(normalizeReceiptItems(free).items).toBe(free);
});

test('exact discounted removal keeps unrelated sale/header discounts intact', () => {
  const [original, reversal, sold] = saleWithItemVoid();
  const result = normalizeReceiptItems([{ ...original, lineTotal: 160, lineDiscount: 10 },
    { ...reversal, lineTotal: -160, lineDiscount: -10 }, sold]);
  expect(receiptEligibleAmount(result.items)).toBe(90);
  expect(buildReceiptSnapshot({ receiptTotalAmount: 85, receiptDiscount: 5 }, result.items)).toMatchObject({ totalAmount: 85, receiptDiscount: 5 });
});

test.each([
  ['different SKU', { productCode: 'OTHER' }], ['different barcode', { barcode: 'OTHER' }],
  ['different unit', { unitCode: 'BOX' }], ['different unit name', { unitName: 'กล่อง' }],
  ['different price', { unitPrice: 86 }], ['different name', { productName: 'Void - Other' }],
  ['different discount', { lineDiscount: 1 }], ['different promotion', { promotionCode: 'OTHER' }],
  ['partial quantity without proven native reference', { qty: -1, lineTotal: -85 }],
  ['different amount', { lineTotal: -169 }], ['unmarked negative', { productName: 'Returned medicine' }],
  ['positive amount on negative quantity', { lineTotal: 170 }],
])('rejects %s without changing source data', (label, change) => {
  const input = saleWithItemVoid(); input[1] = { ...input[1], ...change };
  const before = JSON.stringify(input);
  expect(() => normalizeReceiptItems(input)).toThrow(); expect(JSON.stringify(input)).toBe(before);
});

test('an orphan reversal never cancels an item added later; a double reversal cannot consume it twice', () => {
  const [original, reversal, sold] = saleWithItemVoid();
  expect(() => normalizeReceiptItems([reversal, { ...original, seq: 3 }, { ...sold, seq: 4 }])).toThrow();
  expect(() => normalizeReceiptItems([original, reversal, { ...reversal, seq: 3 }, { ...sold, seq: 4 }])).toThrow();
});

test('all-cancelled receipt is rejected instead of claiming phantom items', () => {
  expect(() => normalizeReceiptItems(saleWithItemVoid().slice(0, 2))).toThrow('ยกเลิกสินค้าทั้งหมด');
});

test('legacy clients without sequence numbers retain source ordering', () => {
  const input = saleWithItemVoid().map(({ seq, ...item }) => item);
  expect(normalizeReceiptItems(input).items.map(i => i.seq)).toEqual([3, 4]);
});

test('duplicate or out-of-order source sequences are never guessed', () => {
  const input = saleWithItemVoid(); input[1].seq = 1;
  expect(() => normalizeReceiptItems(input)).toThrow('ลำดับ');
});

test.each([null, [], Array(1001).fill({}), [null], [{ qty: NaN }], [{ qty: 1, unitPrice: 1, lineTotal: Infinity }]])('rejects malformed input %j', input => {
  expect(() => normalizeReceiptItems(input)).toThrow();
});

test('raw audit stores only supported receipt fields', () => {
  const input = saleWithItemVoid(); input[0].unexpectedSecret = 'must-not-persist';
  expect(JSON.stringify(normalizeReceiptItems(input))).not.toContain('must-not-persist');
});

test('distinct oversized identities cannot match after truncation', () => {
  const input = saleWithItemVoid();
  input[0].productCode = 'X'.repeat(255) + '1'; input[1].productCode = 'X'.repeat(255) + '2';
  expect(() => normalizeReceiptItems(input)).toThrow('ยาวเกิน');
});
