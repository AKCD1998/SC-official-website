import "dotenv/config";

function getIntegrationKey() {
  const key = String(process.env.DIGITALPJK_SC_SHIFT_INTEGRATION_KEY || "").trim();
  return key || "";
}

export function scShiftIntegrationRequired(req, res, next) {
  const expectedKey = getIntegrationKey();
  if (!expectedKey) {
    return res.status(503).json({
      error: "DIGITALPJK_SC_SHIFT_INTEGRATION_KEY is not configured.",
    });
  }

  const providedKey = String(req.header("X-Integration-Key") || "").trim();
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(401).json({ error: "Invalid integration key." });
  }

  return next();
}
