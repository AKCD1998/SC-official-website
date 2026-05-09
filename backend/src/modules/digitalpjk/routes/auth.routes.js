import { Router } from "express";
import { getMe, login } from "../controllers/auth.controller.js";
import { authRequired } from "../middleware/auth.middleware.js";
import { loginRateLimit } from "../middleware/login-rate-limit.middleware.js";

const router = Router();

router.post("/auth/login", loginRateLimit, login);
router.get("/auth/me", authRequired, getMe);
router.get("/me", authRequired, getMe);

export default router;
