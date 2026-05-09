import { Router } from "express";
import { listPartTimePharmacistsHandler } from "../controllers/pharmacists.controller.js";
import { authRequired } from "../middleware/auth.middleware.js";

const router = Router();

router.get("/pharmacists/part-time", authRequired, listPartTimePharmacistsHandler);

export default router;
