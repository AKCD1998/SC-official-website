const { requestPharmcarePrint } = require("../services/pharmcarePrintService");
const { forbidden } = require("../errors");
const { normalizeString } = require("../validators");

// Printing physically produces paper and sends a notification to a real LINE group — gated to
// admin sessions only (see appAuth.js / task 6 role split), unlike the read-only inbox routes
// which are open to any authenticated session with fields stripped for non-admin.
async function requestPrint(req, res) {
  if (req.appRole !== "admin") {
    throw forbidden("Only admin sessions can request a print.");
  }

  const result = await requestPharmcarePrint(req.params.id, {
    requestedBy: normalizeString(req.body && req.body.requestedBy),
    reason: normalizeString(req.body && req.body.reason),
  });

  res.json(result);
}

module.exports = { requestPrint };
