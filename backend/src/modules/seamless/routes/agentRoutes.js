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
const {
  MAX_PROVENANCE_JSON_BYTES,
  MAX_SOURCE_BYTES,
} = require("../services/shopeeSalesIngestService");

const router = express.Router();
const shopeeUpload = multer({
  storage: multer.memoryStorage(),
  // Assembled return bundles and e-Tax each use at most ten bounded fields.
  // Busboy also counts the closing boundary, hence ten fields + one file + one
  // boundary.
  limits: {
    fileSize: MAX_SOURCE_BYTES,
    fieldSize: MAX_PROVENANCE_JSON_BYTES,
    fieldNameSize: 64,
    files: 1,
    fields: 10,
    parts: 12,
  },
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
