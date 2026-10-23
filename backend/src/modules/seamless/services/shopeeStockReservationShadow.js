// Deliberately disconnected from routes, workers, stock writers and schedules.
// Identifiers and quantities below are private, in-memory reconciliation data.
const { isDeepStrictEqual } = require('node:util');
const { resolveStockProductMatch, normalizeStockUnit, getStockBaseUnit } = require('./shopeeStockProductMatch');

const SHOP = 'sc-drug-store';
const BRANCH = '004';
const TYPES = new Set(['order_confirmed', 'shipment_due', 'order_cancelled',
  'cancelled_before_dispatch', 'order_shipped', 'order_delivered', 'order_completed',
  'refund_requested', 'refund_completed', 'seller_return_delivery', 'return_received_sellable']);
const VERIFIED_TYPES = new Set(['cancelled_before_dispatch', 'order_shipped',
  'order_delivered', 'order_completed', 'return_received_sellable']);
const positive = n => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const text = v => typeof v === 'string' ? v.normalize('NFKC').trim() : '';
const unit = normalizeStockUnit;
const time = v => typeof v === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(v) ? Date.parse(v) : NaN;
const key = (shop, order) => JSON.stringify([shop, order]);
function increment(counts, reason, n = 1) { counts[reason] = (counts[reason] || 0) + n; }
function fail(code) { throw Object.assign(new Error(code), { code }); }
function checkedSum(a, b) { if (!Number.isSafeInteger(a + b)) fail('QUANTITY_OVERFLOW'); return a + b; }

function indexPosCatalog(records) {
  const index = new Map();
  for (const record of records) {
    const sku = text(record.companySku);
    if (!sku || index.has(sku)) fail('POS_CATALOG_DUPLICATE_OR_INVALID');
    index.set(sku, record);
  }
  return index;
}

function resolvePosUnit(index, sku, quantityUnit) {
  const p = index.get(text(sku));
  if (!p) return { reason: 'pos_product_missing' };
  if (p.active !== true) return { reason: 'pos_product_inactive' };
  if (!text(p.stockCode)) return { reason: 'pos_stock_identity_missing' };
  if (p.stockFactor !== 1 || !Number.isFinite(p.smallFactor) || p.smallFactor <= 0) {
    return { reason: 'pos_stock_factor_unverified' };
  }
  const shared = p.companySku !== p.stockCode;
  if (shared && (p.masterStockCode !== p.stockCode || p.masterActive !== true
    || p.masterStockFactor !== 1 || p.masterSmallFactor !== p.smallFactor)) {
    return { reason: 'shared_stock_conversion_unverified' };
  }
  // No conversion is inferred from similar labels, title contents, prices or barcodes.
  // The existing unit rule must be verified against the actual POS smallest unit.
  if (!quantityUnit) return { reason: 'sale_unit_evidence_missing' };
  if (!text(p.smallUnit)) return { reason: 'pos_unit_label_missing' };
  if (unit(quantityUnit) !== unit(p.smallUnit)) return { reason: 'sale_unit_pos_mismatch' };
  if (p.smallFactor !== 1) return { reason: 'pos_base_unit_factor_unverified' };
  return { stockCode: p.stockCode, shared };
}

function mapShopeeStockLines({ items, posCatalog, matchItem = resolveStockProductMatch,
  validatedUnit = (shop,code) => matchItem.baseUnit?.(shop,code) || getStockBaseUnit(shop,code) } = {}) {
  const index = posCatalog instanceof Map ? posCatalog : indexPosCatalog(posCatalog || []);
  const reasons = {}; const byStock = new Map(); let mappedItems = 0, sourceLabelMismatchItems = 0;
  if (!Array.isArray(items) || !items.length) increment(reasons, 'order_items_missing');
  if (Array.isArray(items) && items.length > 1000) fail('SHADOW_ITEM_LIMIT');
  for (const item of Array.isArray(items) ? items : []) {
    if (!positive(item.quantity)) { increment(reasons, 'sale_quantity_invalid'); continue; }
    // Never trust a productMatch object attached by a caller or an old email import.
    const match = matchItem(SHOP, item, { posCatalog: index });
    let components;
    if (match.status === 'matched') {
      if (match.quantityRuleStatus === 'requires_validation') {
        increment(reasons, 'sale_quantity_rule_unverified'); continue;
      }
      const multiplier = match.quantityRuleStatus === 'verified' ? match.quantityPerSale : 1;
      components = [{ companySku: match.companySku, quantityPerSale: multiplier,
        quantityUnit: match.quantityUnit }];
    } else if (match.status === 'bundle' && match.quantityRuleStatus === 'verified') {
      components = (match.components || []).map(c => ({ ...c,
        quantityUnit: validatedUnit(SHOP, c.companySku)?.quantityUnit }));
    } else {
      const known = new Set(['source_identifier_conflict', 'source_barcode_unverified',
        'verified_mapping_evidence_conflict', 'verified_base_unit_missing', 'physical_stock_rule_required',
        'sale_quantity_rule_unverified', 'sale_quantity_evidence_conflict', 'sale_unit_pos_mismatch',
        'title_pack_requires_evidence']);
      increment(reasons, match.status === 'visibility_only' ? 'visibility_only'
        : known.has(match.reasonCode) ? match.reasonCode : 'product_mapping_unverified');
      continue;
    }
    if (!components.length || components.some(c => !positive(c.quantityPerSale))) {
      increment(reasons, 'sale_quantity_rule_unverified'); continue;
    }
    const resolved = components.map(c => ({ ...c, ...resolvePosUnit(index, c.companySku, c.quantityUnit) }));
    if (resolved.some(c => c.reason)) {
      resolved.filter(c => c.reason).forEach(c => increment(reasons, c.reason)); continue;
    }
    const additions = resolved.map(c => ({ stockCode: c.stockCode,
      quantity: item.quantity * c.quantityPerSale }));
    if (additions.some(c => !positive(c.quantity))) { increment(reasons, 'quantity_overflow'); continue; }
    for (const c of additions) byStock.set(c.stockCode, checkedSum(byStock.get(c.stockCode) || 0, c.quantity));
    if (match.sourceLabelMismatch === true) sourceLabelMismatchItems++;
    mappedItems++;
  }
  return { status: Object.keys(reasons).length ? 'blocked' : 'mapped', reasonCounts: reasons,
    itemCount: Array.isArray(items) ? items.length : 0, mappedItems, sourceLabelMismatchItems,
    // These lines never belong in a public JSON/log. Only summarizeStockShadow is printable.
    lines: [...byStock].sort(([a], [b]) => a.localeCompare(b)).map(([stockCode, quantity]) => ({ stockCode, quantity })) };
}

function projectShopeeStockShadow({ orders = [], events = [], posCatalog = [], posEffects = [],
  stockBasis = [], asOf, coverage = {}, matchItem, validatedUnit, posPostingPolicy } = {}) {
  const cutoff = time(asOf);
  if (!Number.isFinite(cutoff)) fail('SHADOW_AS_OF_REQUIRED');
  if ([orders, events, posCatalog, posEffects, stockBasis].some(a => !Array.isArray(a))
    || orders.length > 20000 || events.length > 100000 || posEffects.length > 100000
    || posCatalog.length > 5000 || stockBasis.length > 20000) fail('SHADOW_INPUT_LIMIT');
  const reasons = {}, groups = new Map(), eventIds = new Map();
  // An explicit owner statement describes this audit's workflow; it is not an
  // inferred POS link, a durable setting, or proof of a historical stock cutover.
  const unpostedWorkflow = posPostingPolicy?.mode === 'not-recorded-in-pos'
    && posPostingPolicy.proof === 'owner-confirmed-current-workflow';
  let duplicateOrders = 0, duplicateEvents = 0, futureEvents = 0;
  const catalog = indexPosCatalog(posCatalog);
  for (const order of orders) {
    if (order.shopCode !== SHOP || order.branchCode !== BRANCH || !text(order.orderKey)) {
      increment(reasons, 'outside_scope_order'); continue;
    }
    const k = key(order.shopCode, order.orderKey);
    const old = groups.get(k);
    if (old) {
      duplicateOrders++;
      if (!isDeepStrictEqual(old.order, order)) old.blocked.add('conflicting_order_snapshots');
    } else groups.set(k, { order, events: [], blocked: new Set() });
  }
  for (const event of events) {
    const g = groups.get(key(event.shopCode, event.orderKey));
    if (event.shopCode !== SHOP || event.branchCode !== BRANCH || !g) {
      increment(reasons, 'outside_scope_or_unlinked_event'); continue;
    }
    if (!text(event.eventKey) || !Number.isFinite(time(event.occurredAt)) || !TYPES.has(event.type)) {
      g.blocked.add('event_contract_invalid'); continue;
    }
    if (time(event.occurredAt) > cutoff) { futureEvents++; continue; }
    const identity = JSON.stringify([event.shopCode, event.eventKey]);
    const old = eventIds.get(identity);
    if (old) {
      duplicateEvents++;
      if (!isDeepStrictEqual(old.event, event)) {
        old.group.blocked.add('conflicting_duplicate_event'); g.blocked.add('conflicting_duplicate_event');
      }
      continue;
    }
    eventIds.set(identity, { event, group: g });
    if (VERIFIED_TYPES.has(event.type) && event.proof !== 'verified-channel-lifecycle') {
      g.blocked.add('lifecycle_proof_missing'); continue;
    }
    g.events.push(event);
  }
  const basis = new Map();
  for (const b of stockBasis) {
    if (!text(b.stockCode) || !text(b.basisKey) || basis.has(b.stockCode)
      || !Number.isFinite(time(b.observedAt)) || time(b.observedAt) > cutoff) fail('STOCK_BASIS_INVALID');
    basis.set(b.stockCode, b);
  }
  const effects = new Map(), effectIds = new Map(); let duplicateEffects = 0;
  for (const effect of posEffects) {
    const g = groups.get(key(effect.shopCode, effect.orderKey));
    if (!g || effect.shopCode !== SHOP || effect.branchCode !== BRANCH) {
      increment(reasons, 'outside_scope_or_unlinked_pos_effect'); continue;
    }
    const identity = JSON.stringify([effect.shopCode, effect.effectKey]);
    if (!text(effect.effectKey)) { g.blocked.add('pos_effect_identity_missing'); continue; }
    if (effectIds.has(identity)) {
      duplicateEffects++;
      const old = effectIds.get(identity);
      if (!isDeepStrictEqual(old.effect, effect)) {
        old.group.blocked.add('conflicting_duplicate_pos_effect'); g.blocked.add('conflicting_duplicate_pos_effect');
      }
      continue;
    }
    effectIds.set(identity, { effect, group: g });
    const b = basis.get(effect.stockCode);
    if (effect.kind !== 'issue' || effect.proof !== 'verified-pos-issue-in-stock-basis'
      || !b || effect.basisKey !== b.basisKey || !positive(effect.quantity)
      || !Number.isFinite(time(effect.occurredAt)) || time(effect.occurredAt) > time(b.observedAt)) {
      g.blocked.add('pos_issue_or_stock_basis_unverified'); continue;
    }
    const k = key(effect.shopCode, effect.orderKey);
    const byStock = effects.get(k) || new Map();
    byStock.set(effect.stockCode, checkedSum(byStock.get(effect.stockCode) || 0, effect.quantity));
    effects.set(k, byStock);
  }
  const positions = [];
  for (const [k, g] of groups) {
    const mapping = mapShopeeStockLines({ items: g.order.items, posCatalog: catalog, matchItem, validatedUnit });
    Object.keys(mapping.reasonCounts).forEach(r => g.blocked.add(r));
    g.events.sort((a, b) => time(a.occurredAt) - time(b.occurredAt));
    let confirmed = false, dispatched = false, cancelled = false, cancellationUnknown = false;
    let returned = false, refund = false;
    const ties = new Map();
    for (const e of g.events) {
      const at = time(e.occurredAt);
      const types = ties.get(at) || new Set(); types.add(e.type); ties.set(at, types);
      if (['order_confirmed', 'shipment_due'].includes(e.type)) {
        if (cancelled) g.blocked.add('confirmation_after_cancellation');
        confirmed = true;
      }
      if (['order_shipped', 'order_delivered', 'order_completed'].includes(e.type)) {
        if (cancelled) g.blocked.add('dispatch_after_cancellation');
        dispatched = true;
      }
      if (e.type === 'cancelled_before_dispatch') {
        if (dispatched) g.blocked.add('cancellation_after_dispatch');
        cancelled = true; cancellationUnknown = false;
      }
      if (e.type === 'order_cancelled') cancellationUnknown = true;
      if (['refund_requested', 'refund_completed', 'seller_return_delivery'].includes(e.type)) refund = true;
      if (e.type === 'return_received_sellable') returned = true;
    }
    for (const types of ties.values()) {
      if ((types.has('cancelled_before_dispatch') || types.has('order_cancelled'))
        && [...types].some(t => ['order_confirmed', 'shipment_due', 'order_shipped'].includes(t))) {
        g.blocked.add('ambiguous_lifecycle_event_time');
      }
    }
    if (!confirmed && !cancelled) g.blocked.add('confirmation_missing');
    if (cancellationUnknown) g.blocked.add('cancellation_dispatch_unverified');
    if (refund || returned) g.blocked.add('return_requires_pos_reconciliation');
    const issued = effects.get(k) || new Map();
    if (unpostedWorkflow && issued.size) g.blocked.add('pos_posting_policy_contradicted');
    if ([...issued.keys()].some(s => !mapping.lines.some(l => l.stockCode === s))) g.blocked.add('pos_issue_product_mismatch');
    const lines = mapping.lines.map(l => {
      const consumed = issued.get(l.stockCode) || 0;
      if (consumed > l.quantity) g.blocked.add('pos_issue_exceeds_order');
      if (cancelled && consumed) g.blocked.add('cancellation_after_pos_issue');
      // A return never subtracts from lifetime issued units or reopens an old reservation.
      const outstanding = cancelled ? 0 : Math.max(0, l.quantity - consumed);
      return { stockCode: l.stockCode, orderedQuantity: l.quantity, issuedInBasis: consumed,
        remainingReservedQuantity: dispatched ? 0 : outstanding,
        unpostedShippedQuantity: dispatched ? outstanding : 0,
        unrepresentedDemandQuantity: outstanding };
    });
    if (dispatched && !unpostedWorkflow && lines.some(l => l.unrepresentedDemandQuantity > 0)) {
      g.blocked.add('dispatched_pos_issue_link_missing');
    }
    for (const r of g.blocked) increment(reasons, r);
    positions.push({ orderKey: g.order.orderKey, state: g.blocked.size ? 'review_required'
      : cancelled ? 'released' : lines.every(l => l.unrepresentedDemandQuantity === 0) ? 'consumed'
        : dispatched ? 'shipped_unposted' : 'reserved',
    mappingStatus: mapping.status, itemCount: mapping.itemCount, mappedItems: mapping.mappedItems,
    sourceLabelMismatchItems: mapping.sourceLabelMismatchItems,
    lines, reasonCodes: [...g.blocked].sort() });
  }
  return { asOf, positions, reasonCounts: reasons, duplicateOrders, duplicateEvents, duplicateEffects,
    futureEvents, posPostingPolicy: unpostedWorkflow ? 'owner-confirmed-not-recorded-in-pos' : 'verified-links-required',
    coverage: { emailComplete: coverage.emailComplete === true, lifecycleComplete: coverage.lifecycleComplete === true,
      posLinksComplete: coverage.posLinksComplete === true, stockCutoverVerified: coverage.stockCutoverVerified === true } };
}

function summarizeStockShadow(result) {
  const p = result.positions;
  const counts = state => p.filter(x => x.state === state).length;
  const allCoverage = Object.values(result.coverage).every(v => v === true);
  const labelReviewRequired = p.some(x => x.sourceLabelMismatchItems > 0);
  return { schemaVersion: 'shopee004-stock-reservation-shadow-v1', branch: BRANCH, shop: SHOP,
    mode: 'shadow', asOf: result.asOf, status: allCoverage && !Object.keys(result.reasonCounts).length
      && !labelReviewRequired ? 'PASS' : 'PARTIAL',
    ordersEvaluated: p.length, fullyMappedOrders: p.filter(x => x.mappingStatus === 'mapped').length,
    itemLines: p.reduce((n, x) => n + x.itemCount, 0), mappedItemLines: p.reduce((n, x) => n + x.mappedItems, 0),
    sourceLabelMismatchOrders: p.filter(x => x.sourceLabelMismatchItems > 0).length,
    sourceLabelMismatchItemLines: p.reduce((n, x) => n + x.sourceLabelMismatchItems, 0),
    reservedOrders: counts('reserved'), releasedOrders: counts('released'), consumedOrders: counts('consumed'),
    shippedUnpostedOrders: counts('shipped_unposted'), posPostingPolicy: result.posPostingPolicy,
    reviewRequiredOrders: counts('review_required'), duplicateOrdersIgnored: result.duplicateOrders,
    duplicateEventsIgnored: result.duplicateEvents, duplicatePosEffectsIgnored: result.duplicateEffects,
    futureEventsIgnored: result.futureEvents, reasonCounts: { ...result.reasonCounts }, coverage: { ...result.coverage },
    eligibleForLiveStock: false, websiteQuantitiesChanged: false, stockWritesRequested: false,
    fullSyncDeltaOrHourlyChanged: false };
}

module.exports = { mapShopeeStockLines, projectShopeeStockShadow, summarizeStockShadow };
