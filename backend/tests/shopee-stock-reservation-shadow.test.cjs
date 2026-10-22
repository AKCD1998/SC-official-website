const { Readable } = require('node:stream');
const { mapShopeeStockLines, projectShopeeStockShadow, summarizeStockShadow } = require('../src/modules/seamless/services/shopeeStockReservationShadow');
const { run } = require('../scripts/shopee-stock-shadow.cjs');
const at = minute => `2026-10-22T10:${String(minute).padStart(2, '0')}:00.000Z`;
const scope = { shopCode: 'sc-drug-store', branchCode: '004', orderKey: 'synthetic-order' };
const item = { name: 'Synthetic product', variant: 'one pack', quantity: 2 };
const pos = { companySku: 'synthetic-product', stockCode: 'synthetic-product', active: true,
  stockFactor: 1, smallFactor: 1, smallUnit: 'ซอง' };
const match = { status: 'matched', companySku: pos.companySku, quantityUnit: 'sachet' };
const matcher = () => match;
const event = (type, minute = 1, more = {}) => ({ ...scope, type, eventKey: `synthetic-${type}-${minute}`,
  occurredAt: at(minute), ...more });
const proof = { proof: 'verified-channel-lifecycle' };
const basis = { stockCode: pos.stockCode, basisKey: 'synthetic-basis', observedAt: at(20) };
const issue = (quantity = 2, more = {}) => ({ ...scope, effectKey: 'synthetic-effect', stockCode: pos.stockCode,
  quantity, kind: 'issue', occurredAt: at(10), basisKey: basis.basisKey,
  proof: 'verified-pos-issue-in-stock-basis', ...more });
function project(overrides = {}) {
  return projectShopeeStockShadow({ orders: [{ ...scope, items: [item] }],
    events: [event('order_confirmed')], posCatalog: [pos], matchItem: matcher,
    asOf: at(30), ...overrides });
}
const position = r => r.positions[0];

test('confirmed demand reserves units without changing any stock writer', () => {
  const r = project();
  expect(position(r)).toMatchObject({ state: 'reserved', lines: [{ remainingReservedQuantity: 2 }] });
  expect(summarizeStockShadow(r)).toMatchObject({ status: 'PARTIAL', eligibleForLiveStock: false,
    websiteQuantitiesChanged: false, stockWritesRequested: false, fullSyncDeltaOrHourlyChanged: false });
});
test('an explicit verified cancellation before dispatch releases the reservation', () => {
  const r = project({ events: [event('order_confirmed'), event('cancelled_before_dispatch', 2, proof)] });
  expect(position(r)).toMatchObject({ state: 'released', lines: [{ remainingReservedQuantity: 0 }] });
});
test('cancellation email alone cannot establish whether dispatch already happened', () => {
  expect(position(project({ events: [event('order_confirmed'), event('order_cancelled', 2)] })))
    .toMatchObject({ state: 'review_required', reasonCodes: ['cancellation_dispatch_unverified'] });
});
test('email replay and the same order arriving twice never reserve twice', () => {
  const e = event('order_confirmed'); const order = { ...scope, items: [item] };
  const r = project({ orders: [order, structuredClone(order)], events: [e, structuredClone(e)] });
  expect(r.positions).toHaveLength(1);
  expect(position(r).lines[0].remainingReservedQuantity).toBe(2);
  expect(summarizeStockShadow(r)).toMatchObject({ duplicateOrdersIgnored: 1, duplicateEventsIgnored: 1 });
});
test('out-of-order backfill has the same result as chronological evidence', () => {
  const events = [event('order_confirmed'), event('shipment_due', 2), event('cancelled_before_dispatch', 3, proof)];
  expect(project({ events: events.toReversed() })).toEqual(project({ events }));
});
test('a confirmed POS issue already present in the selected stock basis retires the reservation', () => {
  expect(position(project({ posEffects: [issue()], stockBasis: [basis] })))
    .toMatchObject({ state: 'consumed', lines: [{ issuedInBasis: 2, remainingReservedQuantity: 0 }] });
});
test('partial POS issue retains only the outstanding quantity and duplicate issue is idempotent', () => {
  const r = project({ posEffects: [issue(1), issue(1)], stockBasis: [basis] });
  expect(position(r)).toMatchObject({ state: 'reserved', lines: [{ remainingReservedQuantity: 1 }] });
  expect(r.duplicateEffects).toBe(1);
});
test.each([
  ['different stock basis', { basisKey: 'different-basis' }],
  ['dry-run quotation', { proof: 'queued_dry_run' }],
  ['unverified POS link', { proof: null }],
  ['return cannot reopen a reservation', { kind: 'return' }],
  ['future issue not in the stock basis', { occurredAt: at(25) }],
  ['invalid issue quantity', { quantity: -1 }],
])('%s cannot retire reserved stock', (_name, change) => {
  const r = project({ posEffects: [issue(2, change)], stockBasis: [basis] });
  expect(position(r).state).toBe('review_required');
  expect(position(r).lines[0].remainingReservedQuantity).toBe(2);
});
test.each(['refund_requested', 'refund_completed', 'seller_return_delivery', 'return_received_sellable'])
  ('%s never directly adds on-hand stock or reopens issued demand', type => {
    const r = project({ events: [event('order_confirmed'), event(type, 15, proof)], posEffects: [issue()], stockBasis: [basis] });
    expect(position(r).state).toBe('review_required');
    expect(position(r).lines[0].remainingReservedQuantity).toBe(0);
    expect(summarizeStockShadow(r).stockWritesRequested).toBe(false);
  });
test.each(['order_shipped', 'order_delivered', 'order_completed'])('%s requires a matching POS issue before releasing', type => {
  const events = [event('order_confirmed'), event(type, 15, proof)];
  expect(position(project({ events })).reasonCodes).toContain('dispatched_pos_issue_link_missing');
  expect(position(project({ events, posEffects: [issue()], stockBasis: [basis] })).state).toBe('consumed');
});
test('an issue larger than the order is reviewable rather than clamped into a passing result', () => {
  expect(position(project({ posEffects: [issue(3)], stockBasis: [basis] })).reasonCodes).toContain('pos_issue_exceeds_order');
});
test('issue product mismatch cannot release another product', () => {
  const other = { ...basis, stockCode: 'synthetic-other-product' };
  const r = project({ stockBasis: [other], posEffects: [issue(2, { stockCode: other.stockCode })] });
  expect(position(r).reasonCodes).toContain('pos_issue_product_mismatch');
});
test.each([
  ['different repeated email', { ...event('order_confirmed'), type: 'shipment_due' }, 'conflicting_duplicate_event'],
  ['invalid timestamp', { ...event('order_confirmed'), occurredAt: '2026-10-22 10:00' }, 'event_contract_invalid'],
  ['invented event status', { ...event('order_confirmed'), type: 'unknown' }, 'event_contract_invalid'],
  ['unproven dispatch', event('order_shipped', 2), 'lifecycle_proof_missing'],
])('%s is withheld', (_label, extra, reason) => {
  expect(position(project({ events: [event('order_confirmed'), extra] })).reasonCodes).toContain(reason);
});
test('a confirmed order cannot silently resurrect after cancellation', () => {
  const r = project({ events: [event('cancelled_before_dispatch', 1, proof), event('order_confirmed', 2)] });
  expect(position(r).reasonCodes).toContain('confirmation_after_cancellation');
});
test('equal-time cancellation and confirmation is ambiguous regardless of input order', () => {
  const r = project({ events: [event('order_confirmed'), event('cancelled_before_dispatch', 1, proof)] });
  expect(position(r).reasonCodes).toContain('ambiguous_lifecycle_event_time');
});
test('future cancellation does not release current stock', () => {
  const r = project({ events: [event('order_confirmed'), event('cancelled_before_dispatch', 40, proof)] });
  expect(position(r).state).toBe('reserved'); expect(r.futureEvents).toBe(1);
});
test('cross-shop and cross-branch data cannot change the 004 projection', () => {
  const r = project({ events: [event('order_confirmed'), event('order_cancelled', 2, { shopCode: 'dr-morepen' }),
    event('order_cancelled', 3, { branchCode: '001' })] });
  expect(position(r).state).toBe('reserved');
  expect(r.reasonCounts.outside_scope_or_unlinked_event).toBe(2);
});
test('different snapshots of the same order cannot be added together', () => {
  const r = project({ orders: [{ ...scope, items: [item] }, { ...scope, items: [{ ...item, quantity: 3 }] }] });
  expect(position(r).reasonCodes).toContain('conflicting_order_snapshots');
});
test('one missing item unit withholds the entire order rather than reserving its mapped subset', () => {
  const r = project({ orders: [{ ...scope, items: [item, { ...item, quantity: 0 }] }] });
  expect(position(r)).toMatchObject({ mappingStatus: 'blocked', state: 'review_required' });
});
test('a verified multipack is multiplied once into the POS base unit', () => {
  const r = project({ matchItem: () => ({ ...match, quantityRuleStatus: 'verified', quantityPerSale: 6 }) });
  expect(position(r).lines[0].remainingReservedQuantity).toBe(12);
});
test('verified bundle components sharing the same stock pool are summed once per component', () => {
  const bundle = () => ({ status: 'bundle', quantityRuleStatus: 'verified', components: [
    { companySku: pos.companySku, quantityPerSale: 2 }, { companySku: pos.companySku, quantityPerSale: 1 }] });
  const r = project({ matchItem: bundle, validatedUnit: () => ({ quantityUnit: 'sachet' }) });
  expect(position(r).lines).toHaveLength(1); expect(position(r).lines[0].remainingReservedQuantity).toBe(6);
});
test.each([
  ['unknown sale unit', { quantityUnit: undefined }, {}, 'sale_unit_evidence_missing'],
  ['box is not a sachet', { quantityUnit: 'box' }, {}, 'sale_unit_pos_mismatch'],
  ['quantity guess', { quantityRuleStatus: 'requires_validation' }, {}, 'sale_quantity_rule_unverified'],
  ['unmapped listing', { status: 'unmapped' }, {}, 'product_mapping_unverified'],
  ['visibility-only listing', { status: 'visibility_only' }, {}, 'visibility_only'],
  ['inactive product', {}, { active: false }, 'pos_product_inactive'],
  ['non-unit stock factor', {}, { stockFactor: 10 }, 'pos_stock_factor_unverified'],
  ['unverified smallest factor', {}, { smallFactor: 10 }, 'pos_base_unit_factor_unverified'],
  ['missing stock identity', {}, { stockCode: '' }, 'pos_stock_identity_missing'],
])('%s is blocked without guessed conversions', (_name, matchChange, posChange, reason) => {
  const r = project({ matchItem: () => ({ ...match, ...matchChange }), posCatalog: [{ ...pos, ...posChange }] });
  expect(position(r).reasonCodes).toContain(reason);
});
test('one-to-one shared aliases use the common stock identity without deriving factors from labels', () => {
  const alias = { ...pos, stockCode: 'synthetic-master', masterStockCode: 'synthetic-master',
    masterActive: true, masterStockFactor: 1, masterSmallFactor: 1 };
  expect(position(project({ posCatalog: [alias] })).lines[0].stockCode).toBe('synthetic-master');
  expect(position(project({ posCatalog: [{ ...alias, masterSmallFactor: 12 }] })).reasonCodes)
    .toContain('shared_stock_conversion_unverified');
});
test('caller-supplied productMatch and stock quantity fields cannot bypass the trusted matcher', () => {
  const r = project({ matchItem: () => ({ status: 'unmapped' }), orders: [{ ...scope, items: [{ ...item,
    productMatch: match, onHand: 999 }] }] });
  expect(position(r).mappingStatus).toBe('blocked');
});
test('invalid positive-integer quantities and overflow never become plausible stock', () => {
  for (const quantity of [null, '', '2', 0, -2, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(mapShopeeStockLines({ items: [{ ...item, quantity }], posCatalog: [pos], matchItem: matcher }).status).toBe('blocked');
  }
});
test('aggregate reporting never includes order identities, product codes or quantities', () => {
  const summary = JSON.stringify(summarizeStockShadow(project()));
  expect(summary).not.toContain(scope.orderKey); expect(summary).not.toContain(pos.companySku);
  expect(summary).not.toContain('remainingReservedQuantity'); expect(summary).not.toContain('orderedQuantity');
});
test('even complete fixture coverage cannot activate stock', () => {
  const r = project({ coverage: { emailComplete: true, lifecycleComplete: true, posLinksComplete: true, stockCutoverVerified: true } });
  expect(summarizeStockShadow(r)).toMatchObject({ status: 'PASS', eligibleForLiveStock: false });
});

const unpostedPolicy = { mode: 'not-recorded-in-pos', proof: 'owner-confirmed-current-workflow' };
test.each(['order_shipped', 'order_delivered', 'order_completed'])('%s keeps unposted demand once under the explicit owner workflow', type => {
  const r = project({ events: [event('order_confirmed'), event(type, 15, proof)], posPostingPolicy: unpostedPolicy });
  expect(position(r)).toMatchObject({ state: 'shipped_unposted', lines: [{ remainingReservedQuantity: 0,
    unpostedShippedQuantity: 2, unrepresentedDemandQuantity: 2 }] });
  expect(summarizeStockShadow(r)).toMatchObject({ shippedUnpostedOrders: 1, eligibleForLiveStock: false,
    coverage: { stockCutoverVerified: false } });
});
test('an unverified workflow declaration cannot excuse missing POS evidence', () => {
  const r = project({ events: [event('order_confirmed'), event('order_shipped', 15, proof)],
    posPostingPolicy: { mode: 'not-recorded-in-pos' } });
  expect(position(r).reasonCodes).toContain('dispatched_pos_issue_link_missing');
});
test('subsequent POS posting requires reconciliation of the formerly unposted workflow', () => {
  const r = project({ posPostingPolicy: unpostedPolicy, posEffects: [issue()], stockBasis: [basis] });
  expect(position(r).reasonCodes).toContain('pos_posting_policy_contradicted');
});
test('verified links later retire shipped demand without subtracting it twice', () => {
  const r = project({ events: [event('order_confirmed'), event('order_shipped', 15, proof)],
    posEffects: [issue(1), issue(1)], stockBasis: [basis] });
  expect(position(r)).toMatchObject({ state: 'review_required', lines: [{ issuedInBasis: 1,
    remainingReservedQuantity: 0, unpostedShippedQuantity: 1, unrepresentedDemandQuantity: 1 }] });
  expect(r.duplicateEffects).toBe(1);
});
test('private input rejection and CLI usage cannot echo input or error details', async () => {
  const lines = []; const output = s => lines.push(s);
  expect(await run({ argv: ['--enable'], output })).toBe(2);
  expect(await run({ argv: ['--stdin'], stdin: Readable.from(['private invalid input']), output })).toBe(1);
  expect(lines.join('')).not.toContain('private invalid input');
});
test('CLI emits only the aggregate and has no live activation mode', async () => {
  const lines = [];
  const result = await run({ argv: ['--stdin'], stdin: Readable.from([JSON.stringify({ asOf: at(30) })]), output: x => lines.push(x) });
  expect(result).toBe(0); expect(JSON.parse(lines[0])).toMatchObject({ mode: 'shadow', eligibleForLiveStock: false });
});
