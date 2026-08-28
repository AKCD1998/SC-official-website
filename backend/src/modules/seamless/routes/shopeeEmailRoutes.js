const express = require("express");
const {
  getAccountingCycleStatus,
} = require("../controllers/shopeeAccountingCycleController");
const { listInbox } = require("../controllers/shopeeEmailController");
const {
  listLegacyReviews,
  saveLegacyReview,
} = require("../controllers/shopeeLegacyReconciliationController");
const {
  getOrder,
  listOrders,
  syncOrders,
} = require("../controllers/shopeeOrderController");
const { appAuth } = require("../middleware/appAuth");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

router.use(appAuth);
router.get("/accounting-cycle", asyncHandler(getAccountingCycleStatus));
router.get("/inbox", asyncHandler(listInbox));
router.get("/orders", asyncHandler(listOrders));
router.get("/orders/legacy-reconciliation", asyncHandler(listLegacyReviews));
router.post(
  "/orders/legacy-reconciliation/:orderNumber",
  asyncHandler(saveLegacyReview),
);
router.get("/orders/:orderNumber", asyncHandler(getOrder));
router.post("/orders/sync", asyncHandler(syncOrders));

module.exports = router;
