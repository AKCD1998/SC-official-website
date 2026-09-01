const {
  SHOPEE_DRMOREPEN_MAILBOX,
  SHOPEE_SC_DRUG_STORE_MAILBOX,
  readShopeeGmailPushConfig,
} = require("../config");
const { badRequest } = require("../errors");
const {
  verifyGooglePubsubOidcRequest,
} = require("../services/googlePubsubOidcVerifier");
const {
  scheduleShopeeGmailPushSync,
} = require("../services/shopeeGmailPushSyncScheduler");

const MAX_PUBSUB_DATA_LENGTH = 16 * 1024;
const SHOP_BY_MAILBOX = Object.freeze({
  [SHOPEE_SC_DRUG_STORE_MAILBOX]: "sc-drug-store",
  [SHOPEE_DRMOREPEN_MAILBOX]: "dr-morepen",
});

function parseGmailPubsubEnvelope(body) {
  const encodedData = body?.message?.data;
  if (typeof encodedData !== "string" || !encodedData || encodedData.length > MAX_PUBSUB_DATA_LENGTH) {
    throw badRequest("Pub/Sub message.data is missing or invalid.");
  }

  let notification;
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedData) || encodedData.length % 4 === 1) {
      throw new Error("invalid base64");
    }
    notification = JSON.parse(Buffer.from(encodedData, "base64").toString("utf8"));
  } catch (error) {
    throw badRequest("Pub/Sub message.data is not valid base64-encoded JSON.");
  }

  const emailAddress = String(notification?.emailAddress || "").trim().toLowerCase();
  const historyId = String(notification?.historyId || "").trim();
  if (!emailAddress || !/^\d+$/.test(historyId)) {
    throw badRequest("Gmail notification emailAddress or historyId is invalid.");
  }

  return {
    emailAddress,
    historyId,
    messageId: String(body?.message?.messageId || "").trim() || null,
  };
}

async function handleShopeeGmailWebhook(req, res) {
  await verifyGooglePubsubOidcRequest(req, readShopeeGmailPushConfig());
  const notification = parseGmailPubsubEnvelope(req.body);
  const shopCode = SHOP_BY_MAILBOX[notification.emailAddress];

  // An authenticated topic may accidentally be connected to another mailbox. Acknowledge that
  // poison message so Pub/Sub does not retry it forever, but never let it select credentials or
  // trigger a sync dynamically.
  if (!shopCode) {
    console.warn(JSON.stringify({
      emailAddress: notification.emailAddress,
      messageId: notification.messageId,
      type: "shopee_gmail_push_mailbox_ignored",
    }));
    res.status(204).end();
    return;
  }

  // Verification and parsing happen before the acknowledgement. The expensive Gmail/DB work
  // starts after 204 so it cannot exceed Pub/Sub's push deadline and create duplicate retries.
  res.status(204).end();
  Promise.resolve()
    .then(() => scheduleShopeeGmailPushSync({
      historyId: notification.historyId,
      messageId: notification.messageId,
      shopCode,
    }))
    .catch((error) => {
      console.error(JSON.stringify({
        httpStatus: error?.response?.status || error?.statusCode || null,
        name: error?.name || "Error",
        shopCode,
        type: "shopee_gmail_push_background_failure",
      }));
    });
}

module.exports = {
  handleShopeeGmailWebhook,
  parseGmailPubsubEnvelope,
};
