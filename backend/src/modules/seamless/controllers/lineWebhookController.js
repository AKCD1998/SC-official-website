const crypto = require("node:crypto");
const { readLineConfig } = require("../config");
const { logOperation } = require("../db/operationLogRepository");

function verifySignature(rawBody, signature) {
  const lineConfig = readLineConfig();

  if (!lineConfig.channelSecret || !signature) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", lineConfig.channelSecret)
    .update(rawBody || Buffer.alloc(0))
    .digest("base64");

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(String(signature));

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

async function handleLineWebhook(req, res) {
  const signature = req.headers["x-line-signature"];

  if (!verifySignature(req.rawBody, signature)) {
    res.status(401).json({ error: { message: "Invalid LINE signature.", code: "UNAUTHORIZED" } });
    return;
  }

  const events = Array.isArray(req.body && req.body.events) ? req.body.events : [];

  for (const event of events) {
    const groupId = (event.source && event.source.groupId) || "";
    console.log(`[seamless-line-webhook] groupId=${groupId || "n/a"} type=${event.type || "unknown"}`);

    await logOperation({
      scope: "seamless_line",
      action: "line_webhook_event",
      message: `groupId=${groupId || "n/a"} type=${event.type || "unknown"}`,
      metadata: event,
    });
  }

  res.status(200).json({ ok: true });
}

module.exports = { handleLineWebhook };
