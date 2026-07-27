const express = require("express");
const { handleLineWebhook } = require("../controllers/lineWebhookController");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

// No appAuth/internalApiAuth here on purpose — LINE's servers call this directly with no
// Bearer/Basic credential of ours. It is protected instead by HMAC signature verification
// against SEAMLESS_LINE_CHANNEL_SECRET inside handleLineWebhook.
router.post("/webhook", asyncHandler(handleLineWebhook));

module.exports = router;
