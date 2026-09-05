const service = require("./accountingOriginalPrintService");

function startAccountingPrintMaintenance({
  maintain = service.maintain,
  intervalMs = 30000,
} = {}) {
  if (process.env.SEAMLESS_ACCOUNTING_BATCH_ENABLED !== "true") return () => {};
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      await maintain();
    } catch (error) {
      console.error(
        "[accounting-print] Maintenance failed:",
        error.code || error.name,
      );
    } finally {
      running = false;
    }
  }
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}
module.exports = { startAccountingPrintMaintenance };
