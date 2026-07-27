const workbookService = require("../services/workbookService");

async function processWorkbooks(req, res) {
  const payload = await workbookService.processWorkbooks({
    files: req.files || [],
    formatterMode: req.body && req.body.formatterMode,
    previewWorkbookId: req.body && (req.body.previewWorkbookId || req.body.previewSpreadsheetId),
    batchId: req.body && req.body.batchId,
    batchFileCount: req.body && req.body.batchFileCount,
  });

  const allFailed = payload.failures.length && !payload.successes.length;
  const duplicateOnly = allFailed && payload.failures.every((failure) => failure.code === "DUPLICATE_UPLOAD");

  res.status(duplicateOnly ? 409 : allFailed ? 400 : 200).json(payload);
}

module.exports = { processWorkbooks };
