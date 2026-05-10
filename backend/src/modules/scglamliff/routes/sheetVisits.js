import { Router } from 'express';
import requireAuth from '../middlewares/requireAuth.js';
import legacySheetGuard from '../middlewares/legacySheetGuard.js';
import { deleteSheetVisit } from '../controllers/sheetVisitsController.js';

const router = Router();

router.post('/:sheetUuid/delete', requireAuth, legacySheetGuard, deleteSheetVisit);

export default router;
