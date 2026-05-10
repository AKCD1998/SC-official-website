import { Router } from 'express';
import requireAuth from '../middlewares/requireAuth.js';
import { getMonthlyKpiDashboard } from '../controllers/reportingController.js';

const router = Router();

router.get('/kpi-dashboard', requireAuth, getMonthlyKpiDashboard);

export default router;
