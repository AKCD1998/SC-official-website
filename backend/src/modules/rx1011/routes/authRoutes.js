import { Router } from "express";
import { login, logout } from "../controllers/authController.js";
import { verifyToken } from "../middleware/authMiddleware.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.post("/login", asyncHandler(login));
router.post("/logout", verifyToken, asyncHandler(logout));

export default router;
