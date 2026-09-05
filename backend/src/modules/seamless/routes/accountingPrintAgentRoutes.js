const express = require("express");
const multer = require("multer");
const { internalApiAuth } = require("../middleware/internalApiAuth");
const {
  accountingPrintEnabled,
} = require("../middleware/accountingPrintEnabled");
const { asyncHandler } = require("../utils/asyncHandler");
const { download } = require("../controllers/accountingPrintBundleController");
const service = require("../services/accountingOriginalPrintService");
const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 2 },
});
router.use(internalApiAuth);
router.use(accountingPrintEnabled);
router.post(
  "/claim",
  asyncHandler(async (req, res) =>
    res.json(await service.claimWork(req.body || {})),
  ),
);
router.get("/:id/items/:itemId/:kind", asyncHandler(download));
router.post(
  "/items/:itemId/events",
  asyncHandler(async (req, res) =>
    res.json(await service.updateWork(req.params.itemId, req.body || {})),
  ),
);
router.post(
  "/items/:itemId/preview",
  upload.single("preview"),
  asyncHandler(async (req, res) =>
    res.json(
      await service.updateWork(
        req.params.itemId,
        { ...req.body, event: "preview" },
        req.file,
      ),
    ),
  ),
);
module.exports = router;
