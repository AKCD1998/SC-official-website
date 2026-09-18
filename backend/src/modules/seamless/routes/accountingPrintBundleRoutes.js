const express = require("express");
const multer = require("multer");
const { appAuth } = require("../middleware/appAuth");
const {
  accountingPrintEnabled,
} = require("../middleware/accountingPrintEnabled");
const { asyncHandler } = require("../utils/asyncHandler");
const controller = require("../controllers/accountingPrintBundleController");
const {
  exportIncomeOrdersBundle,
  exportIncomeOrders,
  listIncomeOrders,
  previewIncomeOrders,
  previewIncomeOrdersPdf,
} = require("../controllers/accountingIncomeOrderController");
const service = require("../services/accountingOriginalPrintService");
const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 100, fields: 0 },
});
const sourceOriginalUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 20, fields: 0 },
  fileFilter(req, file, callback) {
    callback(null, /\.pdf$/iu.test(file.originalname || ""));
  },
});
router.use(appAuth);
router.use(accountingPrintEnabled);
router.get(
  "/",
  asyncHandler(async (req, res) =>
    res.json({
      batches: await service.listBatches(),
      capabilities: service.capabilities(),
    }),
  ),
);
router.post(
  "/",
  controller.requireAdmin,
  upload.fields([
    { name: "sc-drug-store", maxCount: 50 },
    { name: "dr-morepen", maxCount: 50 },
  ]),
  asyncHandler(controller.upload),
);
// Keep named collection routes above /:id so "income-orders" is never parsed as a batch UUID.
router.get("/income-orders/export.xlsx", asyncHandler(exportIncomeOrders));
router.get("/income-orders/export.zip", asyncHandler(exportIncomeOrdersBundle));
router.get("/income-orders/preview.pdf", asyncHandler(previewIncomeOrdersPdf));
router.get("/income-orders/preview", asyncHandler(previewIncomeOrders));
router.get("/income-orders", asyncHandler(listIncomeOrders));
router.post(
  "/source-originals/:shopCode",
  controller.requireAdmin,
  sourceOriginalUpload.array("files", 20),
  asyncHandler(controller.uploadSourceOriginals),
);
router.get(
  "/source-originals/:sourceId",
  asyncHandler(controller.downloadSourceOriginal),
);
router.get(
  "/:id",
  asyncHandler(async (req, res) =>
    res.json(await service.getBatch(req.params.id)),
  ),
);
router.get("/:id/items/:itemId/:kind", asyncHandler(controller.download));
router.post(
  "/:id/approve",
  controller.requireAdmin,
  asyncHandler(async (req, res) =>
    res.json(
      await service.approveBatch(req.params.id, req.body?.digest, req.appActor),
    ),
  ),
);
router.post(
  "/:id/resolve",
  controller.requireAdmin,
  asyncHandler(async (req, res) =>
    res.json(
      await service.resolvePaused(req.params.id, req.body || {}, req.appActor),
    ),
  ),
);
module.exports = router;
