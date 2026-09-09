const express = require("express");
const multer = require("multer");
const {
  completePrintJob,
  createPrintJob,
  getPrintQueue,
  updatePrintJob,
} = require("../controllers/agentController");
const { asyncHandler } = require("../utils/asyncHandler");
const { internalApiAuth } = require("../middleware/internalApiAuth");
const { shopeeSalesIngestAuth } = require("../middleware/shopeeSalesIngestAuth");
const { ingestSalesSource } = require("../controllers/shopeeSalesIngestController");
const { MAX_SOURCE_BYTES } = require("../services/shopeeSalesIngestService");

const router = express.Router();
const shopeeUpload = multer({
  storage: multer.memoryStorage(),
  // Busboy counts the closing multipart boundary when enforcing this limit,
  // so allow one part beyond the eight fields and one workbook.
  limits: { fileSize: MAX_SOURCE_BYTES, files: 1, fields: 8, parts: 10 },
});

router.post(
  "/shopee/sales-sources",
  shopeeSalesIngestAuth,
  shopeeUpload.single("file"),
  asyncHandler(ingestSalesSource),
);
router.use(internalApiAuth);
router.get("/print-queue", asyncHandler(getPrintQueue));
router.post("/print-jobs", asyncHandler(createPrintJob));
router.patch("/print-jobs/:id", asyncHandler(updatePrintJob));
router.post("/print-jobs/:id/complete", asyncHandler(completePrintJob));

module.exports = router;
