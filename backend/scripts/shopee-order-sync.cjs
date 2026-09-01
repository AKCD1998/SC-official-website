const {
  CONSERVATIVE_UNITS_PER_PAGE,
  MAX_PAGES_PER_RUN,
  PAGE_INTERVAL_MS,
  PAGE_SIZE,
  runScheduledShopeeSync,
} = require("../src/modules/seamless/services/shopeeOrderSyncRunner");

function defaultLog(payload) {
  console.log(JSON.stringify(payload));
}

async function runCli() {
  require("dotenv").config({ quiet: true });
  const pool = require("../db");
  const {
    syncShopeeOrderPage,
  } = require("../src/modules/seamless/services/shopeeOrderTimelineService");
  const { requireShopeeShopCode } = require("../src/modules/seamless/services/shopeeShops");

  try {
    const shopArgument = process.argv.slice(2)
      .find((value) => value.startsWith("--shop-code="));
    const shopCode = requireShopeeShopCode(shopArgument?.slice("--shop-code=".length));
    const result = await runScheduledShopeeSync({ shopCode, syncPage: syncShopeeOrderPage });
    defaultLog({ ...result, type: "shopee_sync_complete" });
  } catch (error) {
    if (error?.statusCode === 409) {
      defaultLog({ reason: "another_sync_is_running", type: "shopee_sync_skipped" });
      return;
    }

    console.error(JSON.stringify({
      httpStatus: error?.response?.status || error?.statusCode || null,
      name: error?.name || "Error",
      type: "shopee_sync_failed",
    }));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  CONSERVATIVE_UNITS_PER_PAGE,
  MAX_PAGES_PER_RUN,
  PAGE_INTERVAL_MS,
  PAGE_SIZE,
  runScheduledShopeeSync,
};
