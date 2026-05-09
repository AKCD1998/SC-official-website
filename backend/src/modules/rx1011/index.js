import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse } from "csv-parse/sync";

import { hasDatabase, healthCheck, query } from "./db/pool.js";
import activeIngredientsRoutes from "./routes/activeIngredientsRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import dispenseRoutes from "./routes/dispenseRoutes.js";
import inventoryRoutes from "./routes/inventoryRoutes.js";
import productsRoutes from "./routes/productsRoutes.js";
import reportingRoutes from "./routes/reportingRoutes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const moduleRoot = __dirname;

function resolvePatientsCsvPath() {
  const configuredPath =
    process.env.RX1011_PATIENTS_CSV_PATH || process.env.PATIENTS_CSV_PATH || "";
  return configuredPath
    ? path.resolve(configuredPath)
    : path.join(moduleRoot, "data", "patients_rows.csv");
}

export function createRx1011Router() {
  const router = express.Router();

  router.get("/health", async (_req, res) => {
    const db = await healthCheck();
    res.status(db.ok ? 200 : 503).json({
      ok: db.ok,
      database: db,
    });
  });

  router.get("/patients", async (_req, res, next) => {
    try {
      if (hasDatabase()) {
        const result = await query(
          `
            SELECT
              pid,
              full_name
            FROM patients
            ORDER BY full_name
            LIMIT 5000
          `
        );
        return res.json(result.rows);
      }

      const csvPath = resolvePatientsCsvPath();
      if (!fs.existsSync(csvPath)) {
        return res.status(500).json({
          error: "Patients source not available",
          detail: "No database connection and CSV file not found",
        });
      }

      const csvText = fs.readFileSync(csvPath, "utf8");
      const rows = parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
      })
        .map((row) => ({
          pid: String(row.pid || row.PID || "").trim(),
          full_name: String(row.full_name || row.FULL_NAME || row.fullName || "").trim(),
        }))
        .filter((row) => row.pid && row.full_name);
      return res.json(rows);
    } catch (error) {
      return next(error);
    }
  });

  router.use("/auth", authRoutes);
  router.use("/admin", adminRoutes);
  router.use("/products", productsRoutes);
  router.use("/", activeIngredientsRoutes);
  router.use("/inventory", inventoryRoutes);
  router.use("/dispense", dispenseRoutes);
  router.use("/", reportingRoutes);

  router.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  router.use((error, _req, res, _next) => {
    const status = Number(error?.status || 500);
    const response = {
      error: error?.message || "Internal Server Error",
    };
    if (error?.details !== undefined) {
      response.details = error.details;
    }
    if (status >= 500) {
      console.error(error);
    }
    res.status(status).json(response);
  });

  return router;
}

export default createRx1011Router;
