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

async function getOrderStockSearchAliases(search, dependencies = {}) {
  const enabled = dependencies.enabled ?? process.env.SHOPEE004_STOCK_LEDGER_ENABLED === 'true';
  // Existing company SKU formats; ordinary name/date/amount searches need no
  // additional registry read. The store still requires an exact stored POS key.
  if (!enabled || !/^(?:IC-\d{6}|\d{9})$/i.test(search || '')) return [];
  try {
    const store = dependencies.identityStore || require('./shopee004StockRuntime').getIdentityStore();
    return await store.stockSearchAliases(search);
  } catch {
    throw Object.assign(Error('Stock SKU search is temporarily unavailable.'), { statusCode: 503, code: 'STOCK_SEARCH_UNAVAILABLE' });
  }
}

module.exports = { enrichOrderStockDisplay, getOrderStockSearchAliases };
