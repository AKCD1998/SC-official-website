const { ingestShopeeSalesSource } = require("../services/shopeeSalesIngestService");

async function ingestSalesSource(req, res) {
  const result = await ingestShopeeSalesSource({ body: req.body || {}, file: req.file });
  res.set("Cache-Control", "no-store");
  res.json(result);
}

module.exports = { ingestSalesSource };
