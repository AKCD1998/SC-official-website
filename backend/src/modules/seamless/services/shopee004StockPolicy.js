const { isDeepStrictEqual } = require('node:util');
const { mapShopeeStockLines } = require('./shopeeStockReservationShadow');

const fail = code => { throw Object.assign(new Error(code), { code, statusCode: 409 }); };
const iso = value => value ? new Date(value).toISOString() : null;
function validateCatalog(catalog) {
  if (!Array.isArray(catalog) || !catalog.length || catalog.length > 1000) fail('POS_UNIT_CONTRACT_REQUIRED');
  if (catalog.some(p => !p || typeof p !== 'object' || Array.isArray(p))) fail('POS_UNIT_CONTRACT_INVALID');
  const index = new Map(catalog.map(p => [p.companySku, { companySku: p.companySku, stockCode: p.stockCode,
    active: p.active, stockFactor: p.stockFactor, smallFactor: p.smallFactor, smallUnit: p.smallUnit,
    // Pack-content cross-checks need the independently observed POS master name.
    // Keep this bounded metadata; discard every unrelated input property.
    productName: typeof p.productName === 'string' ? p.productName : '' }]));
  if (index.size !== catalog.length) fail('POS_UNIT_CONTRACT_INVALID');
  for (const p of catalog) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(p.companySku || '') || p.active !== true || p.companySku !== p.stockCode || p.stockFactor !== 1
      || p.smallFactor !== 1 || typeof p.smallUnit !== 'string' || !p.smallUnit.trim() || p.smallUnit.length > 80
      || (p.productName != null && (typeof p.productName !== 'string' || p.productName.length > 500))) fail('POS_UNIT_CONTRACT_INVALID');
  }
  return index;
}
function orderSnapshot(order) {
  return { items: order.items, orderedAt: iso(order.ordered_at), status: order.current_status,
    lastEventAt: iso(order.last_event_at) };
}
function projectPosition({ order, events, reviews, control, previous, now, matchItem }) {
  const snapshot = orderSnapshot(order);
  const opening = control.plan.opening.some(o => o.orderNumber === order.order_number);
  const confirmed = events.filter(e => ['order_confirmed','shipment_due'].includes(e.event_type));
  const earliest = confirmed.length ? Math.min(...confirmed.map(e => +new Date(e.occurred_at))) : NaN;
  const created = +new Date(order.ordered_at || NaN);
  const cutover = +new Date(control.cutover_at);
  const fresh = Number.isFinite(created) && created >= cutover && earliest >= cutover;
  // Source timestamp corrections cannot turn an excluded historical order into
  // a new deduction, or silently release a previously admitted commitment.
  const eligibility = opening ? 'opening' : previous?.eligibility
    || (control.plan.legacyOrders.includes(order.order_number) ? 'legacy' : fresh ? 'new' : 'legacy');
  const reasons = [];
  if (eligibility === 'legacy') {
    // A late old email never becomes a new deduction. Unknown opening demand is
    // surfaced for review instead of silently assuming it was counted in POS.
    const known = control.plan.legacyOrders.includes(order.order_number)
      || reviews.some(r => r.kind === 'legacy-in-baseline');
    return { eligibility, state: known ? 'legacy_excluded' : 'review_required',
      reasons: known ? [] : ['legacy-arrival-needs-opening-review'], warnings: [], snapshot, lines: [] };
  }
  const catalog = validateCatalog(control.pos_catalog);
  const mapped = mapShopeeStockLines({ items: order.items, posCatalog: catalog, matchItem });
  if (eligibility === 'new' && !fresh) reasons.push('source-order-time-changed-needs-review');
  reasons.push(...Object.keys(mapped.reasonCounts));
  if (!confirmed.length) reasons.push('confirmation-missing');
  if (!Number.isFinite(created)) reasons.push('source-order-time-missing');
  if (events.some(e => +new Date(e.occurred_at) > +now)) reasons.push('source-clock-or-future-event');
  if (previous && !isDeepStrictEqual(previous.source_snapshot.items, snapshot.items)) reasons.push('order-items-changed-needs-review');
  const cancelled = reviews.some(r => r.kind === 'cancel-before-dispatch');
  const dispatched = reviews.some(r => r.kind === 'dispatched');
  const returns = reviews.filter(r => r.kind === 'returned-sellable');
  const lastCancel = reviews.filter(r => r.kind === 'cancel-before-dispatch').at(-1);
  if (cancelled && dispatched) reasons.push('cancel-after-dispatch');
  if (cancelled && confirmed.some(e => +new Date(e.occurred_at) > +new Date(lastCancel.recorded_at))) reasons.push('confirmation-after-cancel');
  if (events.some(e => e.event_type === 'order_cancelled') && !cancelled) reasons.push('cancel-dispatch-unverified');
  if (events.some(e => e.event_type === 'seller_return_delivery') && !returns.length) reasons.push('physical-return-unverified');
  if (returns.length && !dispatched) reasons.push('return-without-dispatch-proof');
  const returned = new Map();
  for (const r of returns) for (const q of r.quantities) {
    returned.set(q.productCode, (returned.get(q.productCode) || 0) + q.quantity);
  }
  if ([...returned.keys()].some(code => !mapped.lines.some(l => l.stockCode === code))) reasons.push('return-product-mismatch');
  const lines = mapped.lines.map(l => {
    const back = returned.get(l.stockCode) || 0;
    if (!Number.isSafeInteger(back) || back < 0 || back > l.quantity) reasons.push('return-exceeds-unposted-demand');
    const outstanding = cancelled ? 0 : Math.max(0, l.quantity - back);
    return { productCode: l.stockCode, unit: catalog.get(l.stockCode).smallUnit, orderedQuantity: l.quantity,
      reservedQuantity: dispatched ? 0 : outstanding, shippedUnpostedQuantity: dispatched ? outstanding : 0 };
  });
  const unique = [...new Set(reasons)].sort();
  return { eligibility, state: unique.length ? 'review_required' : cancelled || lines.every(l => !l.reservedQuantity && !l.shippedUnpostedQuantity)
    ? 'released' : dispatched ? 'shipped_unposted' : 'reserved', reasons: unique,
    warnings: mapped.sourceLabelMismatchItems ? ['owner-confirmed-source-label-mismatch'] : [], snapshot, lines };
}
module.exports = { validateCatalog, orderSnapshot, projectPosition, fail };
