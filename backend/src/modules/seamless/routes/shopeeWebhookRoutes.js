const express = require("express");
const { handleShopeeGmailWebhook } = require("../controllers/shopeeWebhookController");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

// Public only in the network sense: Google-signed OIDC verification happens before the body is
// accepted. Do not put appAuth here because Pub/Sub has no staff browser session.
router.post("/gmail", asyncHandler(handleShopeeGmailWebhook));

module.exports = router;
