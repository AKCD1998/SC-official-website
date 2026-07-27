const express = require("express");
const { downloadGeneratedFile, sendGeneratedFileByEmail } = require("../controllers/fileController");
const { asyncHandler } = require("../utils/asyncHandler");
const { appAuth } = require("../middleware/appAuth");

const router = express.Router();

router.use(appAuth);
router.get("/:id/download", asyncHandler(downloadGeneratedFile));
router.post("/:id/send-email", asyncHandler(sendGeneratedFileByEmail));

module.exports = router;
