// Sales are an ORDER-level measure, not a SKU quantity or a payout. Keep this
// resolver shared by the JSON summary and the accounting export.
const EXCLUDED_STATUSES = new Set(['order_cancelled', 'seller_return_delivery']);

function moneyCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/u.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

function orderKey(order) {
  if (!order.shopCode || !order.orderNumber) throw new Error('Sales order requires shop and order number.');
  return `${order.shopCode}:${order.orderNumber}`;
}

function resolveSalesOrders(orders = []) {
  const byKey = new Map();
  for (const original of orders) {
    const key = orderKey(original);
    const previous = byKey.get(key);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(original)) {
        throw new Error(`Conflicting sales records for ${key}.`);
      }
      continue;
    }
    byKey.set(key, original);
  }
  return [...byKey.values()].flatMap((order) => {
    const source = order.salesSource;
    if (EXCLUDED_STATUSES.has(order.currentStatus) || source?.excluded === true) return [];
    if (!Array.isArray(order.items) || !order.items.length) {
      if (source) throw new Error(`Source-backed order has no usable product data: ${orderKey(order)}`);
      return [];
    }
    const gross = moneyCents(source ? source.itemSubtotal : order.itemSubtotal);
    const seller = source ? moneyCents(source.sellerVoucher) : null;
    const shopee = source ? moneyCents(source.shopeeProductDiscount) : null;
    if (source && (gross === null || seller === null || shopee === null || seller > gross)) {
      throw new Error(`Invalid raw sales components for ${orderKey(order)}.`);
    }
    // Absent raw discounts are UNKNOWN, not zero. The fallback is explicitly an
    // email-subtotal estimate and must never become a verified sales figure.
    const salesCents = source ? gross - seller + shopee : gross;
    return [{
      ...order,
      salesAccounting: {
        basis: source ? 'all_orders' : 'email_estimate',
        grossSubtotal: gross === null ? null : gross / 100,
        sellerVoucher: seller === null ? null : seller / 100,
        shopeeProductDiscount: shopee === null ? null : shopee / 100,
        salesAmount: salesCents === null ? null : salesCents / 100,
        sourceFilename: source?.sourceFilename || null,
        sourceSha256: source?.sourceSha256 || null,
        observedAt: source?.observedAt || null,
        itemQuantityMismatch: source?.itemQuantityMismatch === true,
      },
    }];
  });
}

function summarizeSalesAccounting(orders = []) {
  const resolved = resolveSalesOrders(orders);
  const ledger = resolved.map((order) => ({
    shopCode: order.shopCode,
    orderNumber: order.orderNumber,
    orderedAt: order.orderedAt,
    ...order.salesAccounting,
  })).sort((a, b) => String(a.orderedAt).localeCompare(String(b.orderedAt))
    || orderKey(a).localeCompare(orderKey(b)));
  const provisionalOrderCount = ledger.filter((row) => row.basis !== 'all_orders').length;
  const missingAmountOrderCount = ledger.filter((row) => row.salesAmount === null).length;
  const cents = ledger.reduce((sum, row) => sum + (moneyCents(row.salesAmount) ?? 0), 0);
  if (!Number.isSafeInteger(cents)) throw new Error('Sales total exceeds supported precision.');
  return {
    metric: 'all_orders_sales_less_cancelled_and_returned',
    currency: 'THB',
    status: missingAmountOrderCount ? 'incomplete' : provisionalOrderCount ? 'provisional' : 'source_backed',
    // Source-backed describes the included orders, not completeness of a whole
    // reporting period. No monthly reconciliation is inferred here.
    periodReconciliation: 'not_checked',
    calculatedSalesTotal: missingAmountOrderCount ? null : cents / 100,
    sourceBackedSalesTotal: provisionalOrderCount || missingAmountOrderCount ? null : cents / 100,
    sourceBackedOrderCount: ledger.length - provisionalOrderCount,
    provisionalOrderCount,
    missingAmountOrderCount,
    quantityReviewOrderCount: ledger.filter((row) => row.itemQuantityMismatch).length,
    orders: ledger,
  };
}

module.exports = { moneyCents, orderKey, resolveSalesOrders, summarizeSalesAccounting };
