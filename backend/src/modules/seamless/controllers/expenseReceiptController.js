const expenseReceiptService = require("../services/expenseReceiptService");
const { forbidden } = require("../errors");

const HUMAN_ADMIN_AUTH_SOURCES = new Set(["session", "admin_basic"]);

function requireHumanAdmin(req) {
  const actor = String(req.appActor || "").normalize("NFKC").trim();
  if (
    req.appRole !== "admin" ||
    !HUMAN_ADMIN_AUTH_SOURCES.has(req.appAuthSource) ||
    !actor ||
    actor.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(actor)
  ) {
    throw forbidden("A named human admin session is required for expense receipt actions.");
  }
  return { actor, authSource: req.appAuthSource };
}

async function getPreflight(req, res) {
  res.set("Cache-Control", "no-store");
  res.json(expenseReceiptService.getExpenseReceiptPreflight());
}

async function submitExpenseReceipt(req, res) {
  const identity = requireHumanAdmin(req);
  const payload = await expenseReceiptService.submitExpenseReceipt({
    file: req.file,
    expensePeriod: req.body && req.body.expensePeriod,
    expectedClaimantName: req.body && req.body.expectedClaimantName,
    submittedBy: identity.actor,
  });
  res.status(201).json(payload);
}

async function listExpenseReceipts(req, res) {
  res.json({ records: await expenseReceiptService.listExpenseReceipts(req.query || {}) });
}

async function getExpenseReceipt(req, res) {
  res.json(await expenseReceiptService.getExpenseReceipt(req.params.id));
}

async function approvePrint(req, res) {
  const identity = requireHumanAdmin(req);
  const payload = await expenseReceiptService.approveExpenseReceiptPrint(req.params.id, {
    confirmation: req.body && req.body.confirmation,
    approvedBy: identity.actor,
    authSource: identity.authSource,
  });
  res.status(payload.printQueued ? 201 : 502).json(payload);
}

module.exports = {
  approvePrint,
  getExpenseReceipt,
  getPreflight,
  listExpenseReceipts,
  submitExpenseReceipt,
};
