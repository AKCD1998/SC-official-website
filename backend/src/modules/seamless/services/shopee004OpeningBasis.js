const { isDeepStrictEqual } = require('node:util');
const { mapShopeeStockLines } = require('./shopeeStockReservationShadow');
const { fail } = require('./shopee004StockPolicy');
const ORDER = /^[A-Z0-9]{8,40}$/;
function canonical(lines) { return lines.map(r => ({ productCode: r.productCode, unit: r.unit, quantity: r.quantity }))
  .sort((a, b) => a.productCode.localeCompare(b.productCode)); }
function buildOpeningBasis({ input, rows, openingOrderNumbers, catalog, actor, matchItem, now = new Date() }) {
  if (input == null) return null;
  if (!actor || input.quality !== 'owner-accepted-estimate' || input.ownerAccepted !== true
    || input.olderShippedNotPostedInPos !== true || typeof input.sourceAsOf !== 'string'
    || !/(?:Z|[+-]\d\d:\d\d)$/.test(input.sourceAsOf) || !Number.isFinite(Date.parse(input.sourceAsOf))
    || Date.parse(input.sourceAsOf) > +now || typeof input.periodStart !== 'string'
    || !/(?:Z|[+-]\d\d:\d\d)$/.test(input.periodStart)
    || !Number.isFinite(Date.parse(input.periodStart)) || Date.parse(input.periodStart) > Date.parse(input.sourceAsOf)
    || !Number.isInteger(input.excludedPhysicalReviewOrders) || input.excludedPhysicalReviewOrders < 0
    || input.excludedPhysicalReviewOrders > 20000 || !Array.isArray(input.coveredOrderNumbers)
    || input.coveredOrderNumbers.length > 10000 || input.coveredOrderNumbers.some(o => !ORDER.test(o))
    || new Set(input.coveredOrderNumbers).size !== input.coveredOrderNumbers.length
    || input.coveredOrderNumbers.some(o => openingOrderNumbers.includes(o))
    || !Array.isArray(input.records) || input.records.length > 1000
    || input.records.some(r => !r || typeof r.productCode !== 'string' || typeof r.unit !== 'string'
      || !Number.isSafeInteger(r.quantity) || r.quantity < 1)
    || new Set(input.records.map(r => r.productCode)).size !== input.records.length) fail('OPENING_ESTIMATE_CONTRACT_INVALID');
  const byOrder = new Map(rows.map(o => [o.order_number, o])), totals = new Map();
  for (const number of input.coveredOrderNumbers) {
    const order = byOrder.get(number), at = +new Date(order?.ordered_at || NaN);
    if (!order || !Number.isFinite(at) || at < Date.parse(input.periodStart) || at > Date.parse(input.sourceAsOf)) fail('OPENING_ESTIMATE_SOURCE_WINDOW_INVALID');
    const mapped = mapShopeeStockLines({ items: order.items, posCatalog: catalog, matchItem });
    if (mapped.status !== 'mapped') fail('OPENING_ESTIMATE_MAPPING_REVIEW_REQUIRED');
    for (const line of mapped.lines) {
      const quantity = (totals.get(line.stockCode)?.quantity || 0) + line.quantity;
      if (!Number.isSafeInteger(quantity)) fail('OPENING_ESTIMATE_QUANTITY_OVERFLOW');
      totals.set(line.stockCode, { productCode: line.stockCode, unit: catalog.get(line.stockCode)?.smallUnit, quantity });
    }
  }
  const records = canonical([...totals.values()]);
  if (!isDeepStrictEqual(records, canonical(input.records))) fail('OPENING_ESTIMATE_TOTALS_DIFFER');
  return { quality: 'owner-accepted-estimate', sourceAsOf: new Date(input.sourceAsOf).toISOString(),
    periodStart: new Date(input.periodStart).toISOString(), acceptedBy: actor, acceptedAt: now.toISOString(),
    coveredOrderCount: input.coveredOrderNumbers.length, excludedPhysicalReviewOrders: input.excludedPhysicalReviewOrders,
    olderShippedNotPostedInPos: true, physicalStockVerified: false, records };
}
module.exports = { buildOpeningBasis };
