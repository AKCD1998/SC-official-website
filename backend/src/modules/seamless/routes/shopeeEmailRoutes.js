const express = require("express");
const {
  getAccountingCycleStatus,
} = require("../controllers/shopeeAccountingCycleController");
const {
  confirmDryRunQueue,
  createValidationPreview,
} = require("../controllers/adaSmartShopeeController");
const { listInbox } = require("../controllers/shopeeEmailController");
const {
  applyLegacyReviews,
  getLegacyApplyPlan,
  listLegacyReviews,
  saveLegacyReview,
} = require("../controllers/shopeeLegacyReconciliationController");
const {
  getOrder,
  listOrders,
  listSalesSummary,
  syncOrders,
} = require("../controllers/shopeeOrderController");
const { appAuth } = require("../middleware/appAuth");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

router.use(appAuth);
router.get("/accounting-cycle", asyncHandler(getAccountingCycleStatus));
router.post("/adasmart/validation-preview", asyncHandler(createValidationPreview));
router.post("/adasmart/confirm", asyncHandler(confirmDryRunQueue));
router.get("/inbox", asyncHandler(listInbox));
router.get("/orders", asyncHandler(listOrders));
router.get("/orders/sales-summary", asyncHandler(listSalesSummary));
router.get("/orders/legacy-reconciliation", asyncHandler(listLegacyReviews));
router.get(
  "/orders/legacy-reconciliation/apply-plan",
  asyncHandler(getLegacyApplyPlan),
);
router.post(
  "/orders/legacy-reconciliation/apply",
  asyncHandler(applyLegacyReviews),
);
router.post(
  "/orders/legacy-reconciliation/:orderNumber",
  asyncHandler(saveLegacyReview),
);
router.get("/orders/:orderNumber", asyncHandler(getOrder));
router.post("/orders/sync", asyncHandler(syncOrders));

module.exports = router;
