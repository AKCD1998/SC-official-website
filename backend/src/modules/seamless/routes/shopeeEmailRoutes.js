const express = require("express");
const { listInbox } = require("../controllers/shopeeEmailController");
const {
  getOrder,
  listOrders,
  syncOrders,
} = require("../controllers/shopeeOrderController");
const { appAuth } = require("../middleware/appAuth");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

router.use(appAuth);
router.get("/inbox", asyncHandler(listInbox));
router.get("/orders", asyncHandler(listOrders));
router.get("/orders/:orderNumber", asyncHandler(getOrder));
router.post("/orders/sync", asyncHandler(syncOrders));

module.exports = router;
