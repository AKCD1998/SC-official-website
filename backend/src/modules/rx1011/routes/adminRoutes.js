import { Router } from "express";
import { executeSql, getDatabaseSchema, listTableRows } from "../controllers/adminController.js";
import {
  correctDispenseMovementLot,
  getDispenseMovementLotCorrectionDetail,
} from "../controllers/adminDispenseCorrectionsController.js";
import {
  applyIncidentReportResolution,
  createIncidentReport,
  deleteIncidentReport,
  getIncidentReportById,
  listIncidentReports,
  updateIncidentReport,
  updateIncidentReportStatus,
} from "../controllers/adminIncidentsController.js";
import { listAdminPatients } from "../controllers/adminPatientsController.js";
import { requireRole, verifyToken } from "../middleware/authMiddleware.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.get("/patients", verifyToken, requireRole("ADMIN"), asyncHandler(listAdminPatients));
router.get(
  "/dispense-movements/:id",
  verifyToken,
  requireRole("ADMIN"),
  asyncHandler(getDispenseMovementLotCorrectionDetail)
);
router.patch(
  "/dispense-movements/:id/correct-lot",
  verifyToken,
  requireRole("ADMIN"),
  asyncHandler(correctDispenseMovementLot)
);
router.get("/incidents", verifyToken, requireRole("ADMIN"), asyncHandler(listIncidentReports));
router.get("/incidents/:id", verifyToken, requireRole("ADMIN"), asyncHandler(getIncidentReportById));
router.post("/incidents", verifyToken, requireRole("ADMIN"), asyncHandler(createIncidentReport));
router.patch("/incidents/:id", verifyToken, requireRole("ADMIN"), asyncHandler(updateIncidentReport));
router.post(
  "/incidents/:id/resolution",
  verifyToken,
  requireRole("ADMIN"),
  asyncHandler(applyIncidentReportResolution)
);
router.patch(
  "/incidents/:id/status",
  verifyToken,
  requireRole("ADMIN"),
  asyncHandler(updateIncidentReportStatus)
);
router.delete("/incidents/:id", verifyToken, requireRole("ADMIN"), asyncHandler(deleteIncidentReport));
router.get("/db/schema", verifyToken, requireRole("ADMIN"), asyncHandler(getDatabaseSchema));
router.get("/db/tables/:tableName/rows", verifyToken, requireRole("ADMIN"), asyncHandler(listTableRows));
router.post("/sql/execute", verifyToken, requireRole("ADMIN"), asyncHandler(executeSql));

export default router;
