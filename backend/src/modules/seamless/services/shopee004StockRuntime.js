const { createShopee004StockLedger } = require('./shopee004StockLedger');
let ledger;
function getLedger() {
  if (!ledger) ledger = createShopee004StockLedger({ pool: require('../../../../db'),
    schema: require('../config').readSchemaName(), enabled: process.env.SHOPEE004_STOCK_LEDGER_ENABLED === 'true' });
  return ledger;
}
function startShopee004StockMaintenance({ processOne = () => getLedger().processOne(), enabled = process.env.SHOPEE004_STOCK_LEDGER_ENABLED === 'true',
  intervalMs = 2000, reportFailure = () => console.error('[shopee004-stock] LEDGER_PROCESSING_FAILED') } = {}) {
  if (!enabled) return () => {};
  let running = false, stopped = false;
  async function tick() {
    if (running || stopped) return;
    running = true;
    try { for (let i = 0; i < 50 && !stopped; i++) if (!await processOne()) break; }
    catch { reportFailure(); }
    finally { running = false; }
  }
  const timer = setInterval(tick, intervalMs); timer.unref(); void tick();
  const stop = () => { stopped = true; clearInterval(timer); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  return () => { stop(); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); };
}
module.exports = { getLedger, startShopee004StockMaintenance };
