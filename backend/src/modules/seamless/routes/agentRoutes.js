const express = require("express");
const {
  completePrintJob,
  createPrintJob,
  getPrintQueue,
  updatePrintJob,
} = require("../controllers/agentController");
const { asyncHandler } = require("../utils/asyncHandler");
const { internalApiAuth } = require("../middleware/internalApiAuth");

const router = express.Router();

router.use(internalApiAuth);
router.get("/print-queue", asyncHandler(getPrintQueue));
router.post("/print-jobs", asyncHandler(createPrintJob));
router.patch("/print-jobs/:id", asyncHandler(updatePrintJob));
router.post("/print-jobs/:id/complete", asyncHandler(completePrintJob));

module.exports = router;
