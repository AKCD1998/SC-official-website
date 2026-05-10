import {
  buildAppointmentDraftErrorResponse,
  createAppointmentDraft,
  getAppointmentDraftById,
  listAppointmentDrafts,
  patchAppointmentDraft,
  submitAppointmentDraft,
} from '../services/appointmentDraftsService.js';

function sendDraftError(res, error) {
  const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  const response = buildAppointmentDraftErrorResponse(error, { isProd });

  if (response.status >= 500) {
    console.error(
      '[AppointmentDrafts]',
      JSON.stringify({
        event: 'request_failed',
        status: response.status,
        message: error?.message || 'Server error',
        code: error?.code || null,
        detail: error?.detail || null,
        constraint: error?.constraint || null,
        table: error?.table || null,
        column: error?.column || null,
        where: error?.where || null,
      })
    );
  }
  return res.status(response.status).json(response.body);
}

export async function createAppointmentDraftHandler(req, res) {
  try {
    const draft = await createAppointmentDraft({
      body: req.body,
      user: req.user,
    });
    return res.status(201).json({ ok: true, draft });
  } catch (error) {
    return sendDraftError(res, error);
  }
}

export async function listAppointmentDraftsHandler(req, res) {
  try {
    const result = await listAppointmentDrafts({
      status: req.query?.status,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return sendDraftError(res, error);
  }
}

export async function getAppointmentDraftByIdHandler(req, res) {
  try {
    const draft = await getAppointmentDraftById({
      draftId: req.params?.id,
    });
    return res.json({ ok: true, draft });
  } catch (error) {
    return sendDraftError(res, error);
  }
}

export async function patchAppointmentDraftHandler(req, res) {
  try {
    const draft = await patchAppointmentDraft({
      draftId: req.params?.id,
      body: req.body,
      user: req.user,
    });
    return res.json({ ok: true, draft });
  } catch (error) {
    return sendDraftError(res, error);
  }
}

export async function submitAppointmentDraftHandler(req, res) {
  try {
    const result = await submitAppointmentDraft({
      draftId: req.params?.id,
      user: req.user,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return sendDraftError(res, error);
  }
}
