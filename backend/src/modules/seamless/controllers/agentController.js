const printAgentService = require("../services/printAgentService");

async function getPrintQueue(req, res) {
  const queue = await printAgentService.getPrintQueue();
  res.json({ queue });
}

async function createPrintJob(req, res) {
  const job = await printAgentService.createAgentPrintJob(req.body || {});
  res.status(201).json({ job });
}

async function updatePrintJob(req, res) {
  const job = await printAgentService.updateAgentPrintJob(req.params.id, req.body || {});
  res.json({ job });
}

async function completePrintJob(req, res) {
  const payload = await printAgentService.completeAgentPrintJob(req.params.id);
  res.json(payload);
}

module.exports = {
  completePrintJob,
  createPrintJob,
  getPrintQueue,
  updatePrintJob,
};
