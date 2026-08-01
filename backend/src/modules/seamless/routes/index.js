const express = require("express");
const agentRoutes = require("./agentRoutes");
const appProcessingRecordRoutes = require("./appProcessingRecordRoutes");
const bootstrapRoutes = require("./bootstrapRoutes");
const fileRoutes = require("./fileRoutes");
const lineRoutes = require("./lineRoutes");
const pharmcareRoutes = require("./pharmcareRoutes");
const sessionRoutes = require("./sessionRoutes");
const workbookRoutes = require("./workbookRoutes");
const { errorHandler } = require("../middleware/errorHandler");

const router = express.Router();

router.use("/agent", agentRoutes);
router.use("/app/processing-records", appProcessingRecordRoutes);
router.use("/app/session", sessionRoutes);
router.use("/bootstrap", bootstrapRoutes);
router.use("/files", fileRoutes);
router.use("/line", lineRoutes);
router.use("/app/pharmcare", pharmcareRoutes);
router.use("/workbooks", workbookRoutes);

// Scoped to just these seamless routes — does not affect error handling for the rest of
// sc-official-website's routes mounted elsewhere in server.js.
router.use(errorHandler);

module.exports = router;
