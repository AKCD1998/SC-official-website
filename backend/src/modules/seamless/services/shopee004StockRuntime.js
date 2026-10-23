const { createShopee004StockLedger } = require('./shopee004StockLedger');
const {createShopee004IdentityStore}=require('./shopee004IdentityStore');
const { nextRecovery } = require('./shopee004RecoveryPolicy');
let ledger,identityStore;
function getIdentityStore(){
  if(!identityStore)identityStore=createShopee004IdentityStore({pool:require('../../../../db'),schema:require('../config').readSchemaName(),ledger:()=>getLedger()});
  return identityStore;
}
function getLedger() {
  if (!ledger) ledger = createShopee004StockLedger({ pool: require('../../../../db'),
    schema: require('../config').readSchemaName(), enabled: process.env.SHOPEE004_STOCK_LEDGER_ENABLED === 'true',
    mappingContextProvider:(client,control)=>getIdentityStore().mappingContextProvider(client,control) });
  return ledger;
}
const defaultProcessOne=()=>getLedger().processOne();
function startShopee004StockMaintenance({ processOne = defaultProcessOne, enabled = process.env.SHOPEE004_STOCK_LEDGER_ENABLED === 'true',
  refreshResolvedMappings = () => getLedger().requeueResolvedMappings(), now = () => performance.now(),
  drainIdentityRecovery = processOne===defaultProcessOne?()=>getIdentityStore().drainRecovery():async()=>{},
  mappingRefreshMs = 30000, intervalMs = 2000, maximumPassMs = 1000, maximumOrdersPerPass = 25,
  circuitCooldownMs = 300000, reportFailure = () => console.error('[shopee004-stock] LEDGER_PROCESSING_FAILED') } = {}) {
  if (!enabled) return () => {};
  let running = false, stopped = false, lastMappingRefresh = -Infinity, failures = 0, retryAt = -Infinity;
  async function tick() {
    if (running || stopped || now() < retryAt) return;
    running = true;
    try {
      const started = now();
      for (let i = 0; i < Math.min(50, maximumOrdersPerPass) && !stopped && now() - started < maximumPassMs; i++) {
        if (!await processOne()) break;
      }
      if (!stopped && now() - lastMappingRefresh >= mappingRefreshMs) {
        lastMappingRefresh = now(); await refreshResolvedMappings();
      }
      if (!stopped) await drainIdentityRecovery();
      failures = 0; retryAt = -Infinity;
    }
    catch (error) {
      const recovery = nextRecovery({ error, attemptCount: failures, now: new Date(0) });
      failures = recovery.attemptCount;
      // Connection failures cannot persist a per-order retry state. One bounded
      // per-process circuit protects the existing worker/database. Per-order
      // attempts persist in PostgreSQL whenever that database is reachable.
      retryAt = now() + (recovery.retryAfter ? +new Date(recovery.retryAfter) : circuitCooldownMs);
      if (!recovery.retryAfter) failures = 0;
      reportFailure({ code: recovery.reasonCode, exhausted: recovery.exhausted });
    }
    finally { running = false; }
  }
  const timer = setInterval(tick, intervalMs); timer.unref(); void tick();
  const stop = () => { stopped = true; clearInterval(timer); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  return () => { stop(); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); };
}
module.exports = { getLedger,getIdentityStore, startShopee004StockMaintenance };
