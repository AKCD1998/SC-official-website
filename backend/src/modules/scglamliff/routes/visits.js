import { Router } from 'express';
import { listVisits, createVisit } from '../controllers/visitsController.js';
import requireAuth from '../middlewares/requireAuth.js';
import legacySheetGuard from '../middlewares/legacySheetGuard.js';

const router = Router();

router.get('/', requireAuth, legacySheetGuard, listVisits);
router.post('/', requireAuth, legacySheetGuard, createVisit);

export default router;
