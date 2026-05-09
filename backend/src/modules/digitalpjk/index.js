import express from "express";
import adminRoutes from "./routes/admin.routes.js";
import authRoutes from "./routes/auth.routes.js";
import branchesRoutes from "./routes/branches.routes.js";
import documentsRoutes from "./routes/documents.routes.js";
import healthRoutes from "./routes/health.routes.js";
import pharmacistsRoutes from "./routes/pharmacists.js";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware.js";

export function createDigitalPjkRouter() {
  const router = express.Router();

  router.use(express.json());

  router.use("/", healthRoutes);
  router.use("/", authRoutes);
  router.use("/", branchesRoutes);
  router.use("/", adminRoutes);
  router.use("/", documentsRoutes);
  router.use("/", pharmacistsRoutes);

  router.use(notFoundHandler);
  router.use(errorHandler);

  return router;
}

export default createDigitalPjkRouter;
