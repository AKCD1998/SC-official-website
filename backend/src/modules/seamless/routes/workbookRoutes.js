const express = require("express");
const multer = require("multer");
const { appConfig } = require("../appConfig");
const { processWorkbooks } = require("../controllers/workbookController");
const { appAuth } = require("../middleware/appAuth");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: appConfig.maxUploadBytes,
    files: appConfig.maxBatchFiles,
  },
});

router.use(appAuth);
router.post("/process", upload.any(), asyncHandler(processWorkbooks));

module.exports = router;
