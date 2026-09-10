const { badRequest, forbidden } = require("../errors");
const {
  getShopeeDocumentSyncStatus,
} = require("../services/shopeeDocumentSyncStatusService");

const ALLOWED_DAYS = new Set([14, 31, 90]);

function parseDays(value) {
  if (value === undefined || value === "") return 14;
  const parsed = Number(value);
  if (!ALLOWED_DAYS.has(parsed)) {
    throw badRequest("days must be 14, 31, or 90.");
  }
  return parsed;
}

async function getDocumentSyncStatus(req, res) {
  if (req.appRole !== "admin") {
    throw forbidden("Only admin sessions can view Shopee document sync status.");
  }
  res.set("Cache-Control", "no-store");
  res.json(await getShopeeDocumentSyncStatus({ days: parseDays(req.query?.days) }));
}

module.exports = { getDocumentSyncStatus, parseDays };
