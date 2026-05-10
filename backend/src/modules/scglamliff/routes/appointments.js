import { Router } from 'express';
import {
  listAppointments,
  hardDeleteAppointment,
  softDeleteAppointment,
} from '../controllers/appointmentsController.js';
import requireAuth from '../middlewares/requireAuth.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import {
  cancelAppointment,
  completeAppointment,
  ensureAppointmentFromSheet,
  noShowAppointment,
  revertAppointment,
  syncAppointmentCourse,
} from '../controllers/appointmentServiceController.js';
import { adminBackdateAppointment } from '../controllers/adminAppointmentsController.js';
import {
  listAppointmentCalendarDays,
  listAppointmentsQueue,
  listBookingTreatmentOptions,
} from '../controllers/appointmentsQueueController.js';
import { createStaffAppointment } from '../controllers/staffCreateAppointmentController.js';

const router = Router();

// Ensure an appointments row exists for a sheet booking row (sheet_visits_raw.sheet_uuid).
router.post('/from-sheet/:sheetUuid/ensure', requireAuth, requireAdmin, ensureAppointmentFromSheet);

// Admin-only: create a past appointment (audit logged).
router.post('/admin/backdate', requireAuth, requireAdmin, adminBackdateAppointment);

// Appointments-first queue (for replacing /api/visits?source=sheet later).
router.get('/queue', requireAuth, listAppointmentsQueue);
router.get('/booking-options', requireAuth, listBookingTreatmentOptions);
router.get('/calendar-days', requireAuth, listAppointmentCalendarDays);

router.get('/', listAppointments);
router.post('/', requireAuth, createStaffAppointment);
router.post('/delete-hard', requireAuth, requireAdmin, hardDeleteAppointment);
router.delete('/:id', requireAuth, requireAdmin, softDeleteAppointment);

router.post('/:id/complete', requireAuth, completeAppointment);
router.post('/:id/cancel', requireAuth, cancelAppointment);
router.post('/:id/no-show', requireAuth, noShowAppointment);
router.post('/:id/revert', requireAuth, revertAppointment);
router.post('/:id/sync-course', requireAuth, syncAppointmentCourse);

export default router;
