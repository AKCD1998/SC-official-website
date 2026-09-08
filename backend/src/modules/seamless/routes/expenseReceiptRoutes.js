const express = require("express");
const multer = require("multer");
const {
  approvePrint,
  getExpenseReceipt,
  getPreflight,
  listExpenseReceipts,
  submitExpenseReceipt,
} = require("../controllers/expenseReceiptController");
const { appAuth } = require("../middleware/appAuth");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});

router.use(appAuth);
router.get("/preflight", getPreflight);
router.get("/", asyncHandler(listExpenseReceipts));
router.post("/", upload.single("file"), asyncHandler(submitExpenseReceipt));
router.get("/:id", asyncHandler(getExpenseReceipt));
router.post("/:id/approve-print", asyncHandler(approvePrint));

module.exports = router;
