import { Router } from 'express';
import requireAuth from '../middlewares/requireAuth.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import { checkAppointmentStatus } from '../controllers/debugAppointmentController.js';

const router = Router();

router.get('/appointment/:id/status', requireAuth, requireAdmin, checkAppointmentStatus);

export default router;

