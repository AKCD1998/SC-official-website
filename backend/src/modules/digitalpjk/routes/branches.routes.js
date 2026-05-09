import { Router } from "express";
import {
  getBranchByIdHandler,
  listBranchesHandler,
} from "../controllers/branches.controller.js";
import { authRequired } from "../middleware/auth.middleware.js";

const router = Router();

router.get("/branches", authRequired, listBranchesHandler);
router.get("/branches/:id", authRequired, getBranchByIdHandler);

export default router;
