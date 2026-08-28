require("dotenv").config({ quiet: true });

const catalog = require("../src/modules/seamless/data/shopeeProductCatalog.v1.json");
const {
  verifyShopeeCatalogAgainstErp,
} = require("../src/modules/seamless/services/erpProductCatalogVerifier");

async function run() {
  try {
    const result = await verifyShopeeCatalogAgainstErp({
      catalog,
      internalToken: process.env.SC_ERP_PRODUCT_CATALOG_TOKEN,
      resolveUrl: process.env.SC_ERP_PRODUCT_CATALOG_RESOLVE_URL,
    });
    console.log(JSON.stringify({ ...result, type: "shopee_erp_catalog_verified" }));
  } catch (error) {
    console.error(JSON.stringify({
      code: error.code || "ERP_CATALOG_VERIFICATION_FAILED",
      missingCompanySkuCount: Array.isArray(error.missingCompanySkus)
        ? error.missingCompanySkus.length
        : 0,
      type: "shopee_erp_catalog_verification_failed",
    }));
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { run };
