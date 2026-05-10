import { Router } from 'express';
import requireAuth from '../middlewares/requireAuth.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import {
  getAdminAppointmentById,
  patchAdminAppointment,
} from '../controllers/adminAppointmentsController.js';
import {
  createAdminStaffUser,
  listAdminStaffUsers,
  patchAdminStaffUser,
} from '../controllers/adminStaffUsersController.js';

const router = Router();

router.get('/appointments/:appointmentId', requireAuth, requireAdmin, getAdminAppointmentById);
router.patch('/appointments/:appointmentId', requireAuth, requireAdmin, patchAdminAppointment);
router.get('/staff-users', requireAuth, requireAdmin, listAdminStaffUsers);
router.post('/staff-users', requireAuth, requireAdmin, createAdminStaffUser);
router.patch('/staff-users/:id', requireAuth, requireAdmin, patchAdminStaffUser);

export default router;
