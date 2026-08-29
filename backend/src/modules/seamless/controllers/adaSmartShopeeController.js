const validationService = require("../services/adaSmartShopeeValidationService");
const { badRequest, forbidden } = require("../errors");
const { isUuid } = require("../validators");

const HUMAN_ADMIN_AUTH_SOURCES = new Set(["session", "admin_basic"]);

function requireHumanAdmin(req, { requireActor = false } = {}) {
  if (req.appRole !== "admin" || !HUMAN_ADMIN_AUTH_SOURCES.has(req.appAuthSource)) {
    throw forbidden("Only admin sessions can review or confirm AdaSmart validation plans.");
  }
  const actor = String(req.appActor || "").normalize("NFKC").trim();
  if (requireActor && (!actor || actor.length > 128 || /[\u0000-\u001f\u007f]/u.test(actor))) {
    throw forbidden("A named admin session is required to confirm an AdaSmart validation plan.");
  }
  return { actor, authSource: req.appAuthSource };
}

function requireExactBody(body, expectedKeys) {
  const payload = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const keys = Object.keys(payload).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw badRequest(`Request body must contain only: ${expected.join(", ")}.`, {
      code: "ADASMART_REQUEST_CONTRACT_INVALID",
    });
  }
  return payload;
}

function requireProcessingRecordId(value) {
  const processingRecordId = String(value || "").trim();
  if (!isUuid(processingRecordId)) {
    throw badRequest("processingRecordId must be a UUID.", {
      code: "ADASMART_PROCESSING_RECORD_ID_INVALID",
    });
  }
  return processingRecordId;
}

function createAdaSmartShopeeController(service = validationService) {
  async function createValidationPreview(req, res) {
    requireHumanAdmin(req);
    const body = requireExactBody(req.body, ["processingRecordId"]);
    const payload = await service.createValidationPreview(
      requireProcessingRecordId(body.processingRecordId),
    );
    res.set("Cache-Control", "no-store");
    res.json(payload);
  }

  async function confirmDryRunQueue(req, res) {
    const confirmation = requireHumanAdmin(req, { requireActor: true });
    const body = requireExactBody(req.body, ["planDigest", "processingRecordId"]);
    const planDigest = String(body.planDigest || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(planDigest)) {
      throw badRequest("planDigest must be a SHA-256 digest.", {
        code: "ADASMART_PLAN_DIGEST_INVALID",
      });
    }
    const payload = await service.confirmDryRunQueue(
      requireProcessingRecordId(body.processingRecordId),
      planDigest,
      confirmation,
    );
    res.set("Cache-Control", "no-store");
    res.json(payload);
  }

  return { confirmDryRunQueue, createValidationPreview };
}

module.exports = {
  ...createAdaSmartShopeeController(),
  createAdaSmartShopeeController,
  requireExactBody,
};
