import { Router } from 'express';
import requireAuth from '../middlewares/requireAuth.js';
import {
  createAppointmentDraftHandler,
  getAppointmentDraftByIdHandler,
  listAppointmentDraftsHandler,
  patchAppointmentDraftHandler,
  submitAppointmentDraftHandler,
} from '../controllers/appointmentDraftsController.js';

const router = Router();

router.post('/', requireAuth, createAppointmentDraftHandler);
router.get('/', requireAuth, listAppointmentDraftsHandler);
router.get('/:id', requireAuth, getAppointmentDraftByIdHandler);
router.patch('/:id', requireAuth, patchAppointmentDraftHandler);
router.post('/:id/submit', requireAuth, submitAppointmentDraftHandler);

export default router;
