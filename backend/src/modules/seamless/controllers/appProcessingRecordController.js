const processingRecordAppService = require("../services/processingRecordAppService");

async function listProcessingRecords(req, res) {
  const records = await processingRecordAppService.listProcessingRecords(req.query || {});
  res.json({ records });
}

async function markPrinted(req, res) {
  const payload = await processingRecordAppService.markPrinted(
    req.params.id,
    req.body && req.body.printedBy,
  );
  res.json(payload);
}

async function markUnprinted(req, res) {
  const payload = await processingRecordAppService.markUnprinted(req.params.id);
  res.json(payload);
}

async function requestPrint(req, res) {
  const payload = await processingRecordAppService.requestPrint(req.params.id, req.body || {});
  res.json(payload);
}

module.exports = {
  listProcessingRecords,
  markPrinted,
  markUnprinted,
  requestPrint,
};
