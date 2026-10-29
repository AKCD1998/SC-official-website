'use strict';

// Display only. Accounting copy/export still uses its own productMatch contract.
async function enrichOrderStockDisplay(orders, dependencies = {}) {
  const enabled = dependencies.enabled ?? process.env.SHOPEE004_STOCK_LEDGER_ENABLED === 'true';
  if (!enabled || !orders.some(o => o.shopCode === 'sc-drug-store')) return orders;
  try {
    const store = dependencies.identityStore || require('./shopee004StockRuntime').getIdentityStore();
    return await store.enrichOrdersForStockDisplay(orders);
  } catch {
    (dependencies.reportFailure || (() => console.error('[shopee-stock-display] READ_UNAVAILABLE')))();
    // A failed read must not present an old accounting match as a verified stock
    // unit, nor prevent the user from reading order/payment evidence.
    return orders.map(o => o.shopCode !== 'sc-drug-store' ? o : { ...o, items: o.items.map(item => ({
      ...item, stockProductMatch: { status: 'unavailable', branchCode: '004', components: [] },
    })) });
  }
}

module.exports = { enrichOrderStockDisplay };
