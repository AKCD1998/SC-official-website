import { Router } from "express";
import {
  getAdminSettings,
  updateAdminSettings,
} from "../controllers/admin-settings.controller.js";
import { adminRequired, authRequired } from "../middleware/auth.middleware.js";

const router = Router();

router.get("/admin/settings", authRequired, adminRequired, getAdminSettings);
router.put("/admin/settings", authRequired, adminRequired, updateAdminSettings);

export default router;
