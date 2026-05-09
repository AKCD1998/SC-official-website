import { Router } from "express";
import { getActiveIngredients } from "../controllers/productsController.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.get("/active-ingredients", asyncHandler(getActiveIngredients));

export default router;
