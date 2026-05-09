import { Router } from "express";
import { createDispense, listDispenseHistory } from "../controllers/dispenseController.js";
import { requireBranchAccess, requireRole, verifyToken } from "../middleware/authMiddleware.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.get(
  "/history",
  verifyToken,
  requireRole("ADMIN", "PHARMACIST", "OPERATOR"),
  asyncHandler(listDispenseHistory)
);

router.post(
  "/",
  verifyToken,
  requireRole("ADMIN", "PHARMACIST"),
  requireBranchAccess({
    matchBodyFields: ["branchCode"],
    forceBodyFields: ["branchCode"],
  }),
  asyncHandler(createDispense)
);

export default router;
