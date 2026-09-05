const express = require("express");
const accountingPrintBundleRoutes = require("./accountingPrintBundleRoutes");
const accountingPrintAgentRoutes = require("./accountingPrintAgentRoutes");
const agentRoutes = require("./agentRoutes");
const appProcessingRecordRoutes = require("./appProcessingRecordRoutes");
const bootstrapRoutes = require("./bootstrapRoutes");
const fileRoutes = require("./fileRoutes");
const lineRoutes = require("./lineRoutes");
const pharmcareRoutes = require("./pharmcareRoutes");
const pharmcareWebhookRoutes = require("./pharmcareWebhookRoutes");
const sessionRoutes = require("./sessionRoutes");
const shopeeEmailRoutes = require("./shopeeEmailRoutes");
const shopeeWebhookRoutes = require("./shopeeWebhookRoutes");
const workbookRoutes = require("./workbookRoutes");
const { errorHandler } = require("../middleware/errorHandler");

const router = express.Router();

router.use("/agent", agentRoutes);
router.use("/agent/accounting-print-batches", accountingPrintAgentRoutes);
router.use("/app/accounting-print-bundles", accountingPrintBundleRoutes);
router.use("/app/processing-records", appProcessingRecordRoutes);
router.use("/app/session", sessionRoutes);
router.use("/bootstrap", bootstrapRoutes);
router.use("/files", fileRoutes);
router.use("/line", lineRoutes);
router.use("/app/pharmcare", pharmcareRoutes);
router.use("/app/shopee", shopeeEmailRoutes);
router.use("/pharmcare-webhooks", pharmcareWebhookRoutes);
router.use("/shopee-webhooks", shopeeWebhookRoutes);
router.use("/workbooks", workbookRoutes);

// Scoped to just these seamless routes — does not affect error handling for the rest of
// sc-official-website's routes mounted elsewhere in server.js.
router.use(errorHandler);

module.exports = router;
