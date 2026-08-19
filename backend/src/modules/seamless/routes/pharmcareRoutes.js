const express = require("express");
const { downloadAttachment, getMessageDetail, listInbox } = require("../controllers/pharmcareController");
const { appAuth } = require("../middleware/appAuth");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

router.use(appAuth);
router.get("/inbox", asyncHandler(listInbox));
router.get("/messages/:id", asyncHandler(getMessageDetail));
router.get("/attachments/:id/download", asyncHandler(downloadAttachment));

module.exports = router;
