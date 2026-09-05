const express = require("express");
const multer = require("multer");
const { appAuth } = require("../middleware/appAuth");
const {
  accountingPrintEnabled,
} = require("../middleware/accountingPrintEnabled");
const { asyncHandler } = require("../utils/asyncHandler");
const controller = require("../controllers/accountingPrintBundleController");
const service = require("../services/accountingOriginalPrintService");
const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 100, fields: 0 },
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
