const express = require("express");
const {
  listProcessingRecords,
  markPrinted,
  markUnprinted,
  requestPrint,
} = require("../controllers/appProcessingRecordController");
const { asyncHandler } = require("../utils/asyncHandler");
const { appAuth } = require("../middleware/appAuth");

const router = express.Router();

router.use(appAuth);
router.get("/", asyncHandler(listProcessingRecords));
router.post("/:id/mark-printed", asyncHandler(markPrinted));
router.post("/:id/mark-unprinted", asyncHandler(markUnprinted));
router.post("/:id/request-print", asyncHandler(requestPrint));

module.exports = router;
