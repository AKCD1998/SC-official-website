const express = require("express");
const {
  createProcessingRecord,
  createRouteHandler,
  inspectDatabaseContext,
  listProcessingRecords,
  markPrinted,
  markUnprinted,
  requireInternalApiToken,
  updateProcessingRecord,
  upsertProcessingRecordFromPreview,
} = require("../src/modules/seamless/processingRecords");

const router = express.Router();

router.use(requireInternalApiToken);

router.post(
  "/",
  createRouteHandler(async (req, res) => {
    const record = await createProcessingRecord(req.body || {});
    res.status(201).json({ record });
  }),
);

router.get(
  "/",
  createRouteHandler(async (req, res) => {
    const records = await listProcessingRecords(req.query || {});
    res.json({ records });
  }),
);

router.get(
  "/debug-db",
  createRouteHandler(async (req, res) => {
    const context = await inspectDatabaseContext();
    res.json({ ok: true, context });
  }),
);

router.post(
  "/upsert-preview",
  createRouteHandler(async (req, res) => {
    const payload = await upsertProcessingRecordFromPreview(req.body || {});
    res.json(payload);
  }),
);

router.patch(
  "/:id",
  createRouteHandler(async (req, res) => {
    const record = await updateProcessingRecord(req.params.id, req.body || {});
    res.json({ record });
  }),
);

router.post(
  "/:id/mark-printed",
  createRouteHandler(async (req, res) => {
    const payload = await markPrinted(req.params.id, req.body && req.body.printedBy);
    res.json(payload);
  }),
);

router.post(
  "/:id/mark-unprinted",
  createRouteHandler(async (req, res) => {
    const payload = await markUnprinted(req.params.id);
    res.json(payload);
  }),
);

module.exports = router;
