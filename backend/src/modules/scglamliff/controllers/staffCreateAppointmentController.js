import {
  buildCanonicalAppointmentCreateErrorResponse,
  createCanonicalAppointmentFromBody,
} from '../services/appointmentCreateService.js';

export async function createStaffAppointment(req, res) {
  try {
    const result = await createCanonicalAppointmentFromBody({
      body: req.body,
      user: req.user,
    });
    return res.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    const response = buildCanonicalAppointmentCreateErrorResponse(error, { isProd });
    if (response.status >= 500) {
      console.error(error);
    }
    return res.status(response.status).json(response.body);
  }
}
