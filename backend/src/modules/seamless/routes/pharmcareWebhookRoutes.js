const express = require("express");
const { handleGmailWebhook } = require("../controllers/pharmcareWebhookController");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

// No appAuth here on purpose — Google Pub/Sub calls this with no Basic/Bearer credential of
// ours. Protected instead by a shared secret token on the URL, verified inside
// handleGmailWebhook (same reasoning as lineRoutes.js's HMAC-instead-of-appAuth pattern).
router.post("/gmail", asyncHandler(handleGmailWebhook));

module.exports = router;
