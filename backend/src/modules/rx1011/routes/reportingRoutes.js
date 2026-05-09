import { Router } from "express";
import {
  getDeliverSearchProducts,
  getMovements,
  getStockOnHand,
  listLocations,
} from "../controllers/inventoryController.js";
import {
  getOrganicDispenseLedgerActivityProducts,
  getOrganicDispenseLedgerReport,
} from "../controllers/organicReportsController.js";
import { getPatientDispenseHistory } from "../controllers/dispenseController.js";
import { getIncidentReportById } from "../controllers/adminIncidentsController.js";
import { requireRole, verifyToken } from "../middleware/authMiddleware.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.get(
  "/stock/on-hand",
  verifyToken,
  requireRole("ADMIN", "PHARMACIST", "OPERATOR"),
  asyncHandler(getStockOnHand)
);
router.get(
  "/stock/deliver-search-products",
  verifyToken,
  requireRole("ADMIN", "PHARMACIST", "OPERATOR"),
  asyncHandler(getDeliverSearchProducts)
);
router.get("/movements", verifyToken, requireRole("ADMIN", "PHARMACIST", "OPERATOR"), asyncHandler(getMovements));
router.get("/locations", verifyToken, requireRole("ADMIN", "PHARMACIST", "OPERATOR"), asyncHandler(listLocations));
router.get("/incidents/:id", verifyToken, requireRole("ADMIN", "PHARMACIST", "OPERATOR"), asyncHandler(getIncidentReportById));
router.get("/patients/:pid/dispense", asyncHandler(getPatientDispenseHistory));
router.get(
  "/reports/organic-dispense-ledger/activity-products",
  verifyToken,
  requireRole("ADMIN", "PHARMACIST", "OPERATOR"),
  asyncHandler(getOrganicDispenseLedgerActivityProducts)
);
router.get(
  "/reports/organic-dispense-ledger",
  verifyToken,
  requireRole("ADMIN", "PHARMACIST", "OPERATOR"),
  asyncHandler(getOrganicDispenseLedgerReport)
);

export default router;
