import { Router } from "express";
import {
  acceptTransferRequest,
  createMovement,
  createMovementBatch,
  deleteMovement,
  listTransferRequests,
  rejectTransferRequest,
  receiveInventory,
  transferInventory,
  updateMovementOccurredAtCorrection,
} from "../controllers/inventoryController.js";
import { requireBranchAccess, requireRole, verifyToken } from "../middleware/authMiddleware.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.post(
  "/receive",
  verifyToken,
  requireRole("ADMIN", "PHARMACIST"),
  requireBranchAccess({
    matchBodyFields: ["toBranchCode"],
    forceBodyFields: ["toBranchCode"],
  }),
  asyncHandler(receiveInventory)
);
router.post(
  "/transfer",
  verifyToken,
  requireRole("ADMIN", "PHARMACIST"),
  requireBranchAccess({
    matchBodyFields: ["fromBranchCode"],
    forceBodyFields: ["fromBranchCode"],
  }),
  asyncHandler(transferInventory)
);
router.post(
  "/movements",
  verifyToken,
  requireRole("ADMIN", "PHARMACIST"),
  asyncHandler(createMovement)
);
router.post(
  "/movements/batch",
  verifyToken,
  requireRole("ADMIN", "PHARMACIST"),
  asyncHandler(createMovementBatch)
);
router.get(
  "/transfer-requests",
  verifyToken,
  requireRole("ADMIN", "PHARMACIST"),
  asyncHandler(listTransferRequests)
);
router.post(
  "/transfer-requests/:id/accept",
  verifyToken,
  requireRole("ADMIN", "PHARMACIST"),
  asyncHandler(acceptTransferRequest)
);
router.post(
  "/transfer-requests/:id/reject",
  verifyToken,
  requireRole("ADMIN", "PHARMACIST"),
  asyncHandler(rejectTransferRequest)
);
router.patch(
  "/movements/:id/occurred-at-correction",
  verifyToken,
  requireRole("ADMIN"),
  asyncHandler(updateMovementOccurredAtCorrection)
);
router.delete(
  "/movements/:id",
  verifyToken,
  requireRole("ADMIN"),
  asyncHandler(deleteMovement)
);

export default router;
