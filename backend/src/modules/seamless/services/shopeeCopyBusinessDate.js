const { createHash } = require('node:crypto');
const { moneyCents } = require('./shopeeSalesAccounting');

const localDate = value => {
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? new Date(instant + 7 * 3600000).toISOString().slice(0, 10) : null;
};
const isoTime = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const hashPattern = /^[a-f0-9]{64}$/u;
const keyOf = order => `${order.shopCode}:${order.orderNumber}`;

// A replayed workbook can have a new file hash, row number or delivery status.
// Bind the correction to the actual immutable identity, timestamps, quantities
// and financial components instead. Neither an ERP match nor a master price is
// part of this fingerprint, and raw source facts are never rewritten.
function sourceFactFingerprint(order) {
  const items = (order.items || []).map(item => ({ name: item.name, variant: item.variant || '',
    quantity: item.quantity, unitPriceCents: moneyCents(item.unitPrice) }));
  const fact = { shopCode: order.shopCode, orderNumber: order.orderNumber,
    orderedAt: isoTime(order.orderedAt), paidAt: isoTime(order.paidAt),
    merchandiseCents: moneyCents(order.itemSubtotal), sellerCents: moneyCents(order.sellerVoucher),
    supportCents: moneyCents(order.shopeeProductDiscount), items };
  if (!fact.orderedAt || !fact.paidAt || !items.length
    || [fact.merchandiseCents, fact.sellerCents, fact.supportCents].some(v => v == null)
    || items.some(item => typeof item.name !== 'string' || !item.name
      || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.unitPriceCents == null)) return null;
  return createHash('sha256').update(JSON.stringify(fact)).digest('hex');
}

function validCorrection(correction) {
  const evidence = correction.evidence;
  return correction.enabled === true && validDate(correction.businessDate) && validDate(correction.paidBusinessDate)
    && correction.businessDate !== correction.paidBusinessDate && hashPattern.test(correction.sourceFactFingerprint || '')
    && Number.isFinite(Date.parse(correction.verifiedAt)) && Boolean(correction.verifiedBy)
    && evidence?.kind === 'daily_product_order_reconciliation' && Boolean(evidence.caseId)
    && [correction.businessDate, correction.paidBusinessDate].every(date => evidence.sources?.some(source => (
      source.reportType === 'shopee_confirmed_product_report' && source.date === date
      && hashPattern.test(source.sourceSha256 || '') && Boolean(source.sourceFilename)
    )));
}

function selectCopyCohort(orders, corrections, filters) {
  const relevant = corrections.filter(c => c.shopCode === filters.shopCode && c.enabled !== false
    && [c.businessDate, c.paidBusinessDate].some(date => date >= filters.startDate && date <= filters.endDate));
  const byOrder = new Map(); const issues = []; const audit = [];
  const scopedOrders = orders.filter(o => o.shopCode === filters.shopCode);
  const sources = new Map(scopedOrders.map(o => [keyOf(o), o]));
  for (const correction of relevant) {
    const key = keyOf(correction); const order = sources.get(key);
    const valid = !byOrder.has(key) && validCorrection(correction) && order
      && localDate(order.paidAt) === correction.paidBusinessDate
      && sourceFactFingerprint(order) === correction.sourceFactFingerprint;
    if (!valid) issues.push({ reason: 'หลักฐานจัดวัน Business Insights ของออเดอร์ไม่ครบหรือข้อมูลต้นทางเปลี่ยนแล้ว',
      order: order || { orderNumber: correction.orderNumber } });
    byOrder.set(key, { correction, valid });
    audit.push({ ...correction, applied: Boolean(valid), paidAt: order?.paidAt || null,
      orderedAt: order?.orderedAt || null, sourceSha256: order?.sourceSha256 || null });
  }
  const selected = scopedOrders.flatMap(order => {
    const entry = byOrder.get(keyOf(order));
    const businessDate = entry?.valid ? entry.correction.businessDate : localDate(order.paidAt);
    if (businessDate !== filters.startDate) return [];
    return [{ ...order, copyBusinessDate: businessDate,
      copyDateBasis: entry?.valid ? 'verified_business_date' : 'paid_at',
      copyDateCorrection: entry?.valid ? entry.correction : null }];
  });
  return { orders: selected, issues, corrections: audit };
}

module.exports = { localDate, validDate, sourceFactFingerprint, selectCopyCohort };
