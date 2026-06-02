import { Router } from "express";
import {
  generateDocumentPdf,
  generateMergedDocumentPdf,
  generateScShiftDocumentPreview,
  getDocumentDebugGridHandler,
  getDocumentByIdHandler,
  getRecentDocumentsHandler,
} from "../controllers/documents.controller.js";
import { authRequired } from "../middleware/auth.middleware.js";
import { scShiftIntegrationRequired } from "../middleware/sc-shift-integration.middleware.js";

const router = Router();

router.post("/documents/generate", authRequired, generateDocumentPdf);
router.post("/documents/generate-merged", authRequired, generateMergedDocumentPdf);
router.post(
  "/integrations/sc-shift/document-preview",
  scShiftIntegrationRequired,
  generateScShiftDocumentPreview
);
router.get("/documents/debug-grid", authRequired, getDocumentDebugGridHandler);
router.get("/documents/recent", authRequired, getRecentDocumentsHandler);
router.get("/documents/:id", authRequired, getDocumentByIdHandler);

export default router;
