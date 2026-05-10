import express from "express";
import cookieParser from "cookie-parser";

import authRoutes from "./routes/auth.js";
import appointmentRoutes from "./routes/appointments.js";
import appointmentDraftRoutes from "./routes/appointmentDrafts.js";
import adminAppointmentRoutes from "./routes/adminAppointments.js";
import branchDeviceRegistrationRoutes from "./routes/branchDeviceRegistrations.js";
import reportingRoutes from "./routes/reporting.js";
import debugRoutes from "./routes/debugRoutes.js";
import customersRoutes from "./routes/customers.js";
import visitsRoutes from "./routes/visits.js";
import sheetVisitsRoutes from "./routes/sheetVisits.js";
import { notFoundHandler, errorHandler } from "./middlewares/errorHandlers.js";
import { isProductionRuntime } from "./config/env.js";

export function createScGlamLiffRouter() {
  const router = express.Router();

  router.use(express.json());
  router.use(cookieParser());

  router.get("/health", (_req, res) => {
    res.json({ ok: true, data: { status: "ok" } });
  });

  router.use("/auth", authRoutes);
  router.use("/appointments", appointmentRoutes);
  router.use("/appointment-drafts", appointmentDraftRoutes);
  router.use("/admin", adminAppointmentRoutes);
  router.use("/branch-device-registrations", branchDeviceRegistrationRoutes);
  router.use("/reporting", reportingRoutes);
  if (!isProductionRuntime()) {
    router.use("/debug", debugRoutes);
  }
  router.use("/customers", customersRoutes);
  router.use("/visits", visitsRoutes);
  router.use("/sheet-visits", sheetVisitsRoutes);

  router.use(notFoundHandler);
  router.use(errorHandler);

  return router;
}

export default createScGlamLiffRouter;
