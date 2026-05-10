import { query } from '../db.js';
import { getMonthlyKpiDashboardReport } from '../services/monthlyKpiDashboardService.js';

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export async function getMonthlyKpiDashboard(req, res) {
  try {
    const report = await getMonthlyKpiDashboardReport({
      scope: req.query?.scope,
      month: req.query?.month,
      year: req.query?.year,
      queryFn: query,
    });
    return res.json({ ok: true, report });
  } catch (error) {
    if (error?.status) {
      return res.status(error.status).json({
        ok: false,
        error: error.message,
        reason: error.status === 400 ? 'bad_request' : 'request_failed',
        details: error.details || null,
      });
    }

    console.error('[reportingController] getMonthlyKpiDashboard failed', {
      month: normalizeText(req.query?.month) || null,
      userId: normalizeText(req.user?.id) || null,
      code: normalizeText(error?.code) || null,
      message: normalizeText(error?.message) || 'unknown error',
      detail: normalizeText(error?.detail) || null,
      hint: normalizeText(error?.hint) || null,
      stack: error?.stack || null,
    });

    return res.status(500).json({
      ok: false,
      error: 'ไม่สามารถสรุป KPI dashboard ได้ในขณะนี้',
      reason: 'server_error',
      details: {
        month: normalizeText(req.query?.month) || null,
        partial_support: true,
      },
    });
  }
}
