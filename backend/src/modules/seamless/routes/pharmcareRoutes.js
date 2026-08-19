const express = require("express");
const { downloadAttachment, getMessageDetail, listInbox } = require("../controllers/pharmcareController");
const { requestPrint } = require("../controllers/pharmcarePrintController");
const { appAuth } = require("../middleware/appAuth");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

router.use(appAuth);
router.get("/inbox", asyncHandler(listInbox));
router.get("/messages/:id", asyncHandler(getMessageDetail));
router.get("/attachments/:id/download", asyncHandler(downloadAttachment));
// Admin-only (enforced inside the controller, same pattern as pharmcareController's role
// checks) — see docs/22-pharmcare-print-integration-spec.md.
router.post("/documents/:id/print", asyncHandler(requestPrint));

module.exports = router;
