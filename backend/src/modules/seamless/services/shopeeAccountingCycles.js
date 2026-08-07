const { badRequest } = require('../errors');

// Verified Shopee accounting-cycle profiles, keyed by the cycle's start month (YYYY-MM).
// Each profile is a self-contained description of how a DR.Morepen accounting workbook must
// be built for that cycle: the include window, the completed-time weekly allocation, sheet
// names/order, exact fills, geometry, and the verbatim cell comments. The renderer in
// shopeeWorkbookTransform.js consumes a profile and produces the workbook; it does not invent
// cycle-specific dates, names, colors, or totals.
//
// Only cycles that have been hand-verified against a real export belong here. An unconfigured
// period must fail closed (see resolveCycleProfile) rather than silently reusing another
// cycle's rules — the same fail-closed principle the spec applies everywhere.
//
// Expected row counts and net-revenue totals are deliberately NOT defined here. They are
// regression oracles for tests/verification only; the production renderer computes everything
// from the data and must never hardcode an expected total into the output.

const MONTH_PROFILES = {
  '2026-06': {
    cycleKey: '2026-06',
    cycleLabel: '2026-06',
    // Include window is [periodStart 00:00:00, periodEnd 23:59:59] by order date.
    // June 2026 uses complete Mon-Sun weeks; June 29-30 are carried to the July cycle.
    periodStart: '2026-06-01',
    periodEnd: '2026-06-28',
    cancelledStatus: 'ยกเลิกแล้ว',
    masterSheetName: '06',
    // Weeks are allocated by completed time (raw column BF). Each week is its own sheet and
    // also drives the master-sheet row grouping + per-week master row fill (A:M, full row).
    weeks: [
      { name: '01-07.06', start: '2026-06-01', end: '2026-06-07', masterRowFill: 'FFDAF2D0' },
      { name: '08-14.06', start: '2026-06-08', end: '2026-06-14', masterRowFill: 'FFF2CEEF' },
      { name: '15-21.06', start: '2026-06-15', end: '2026-06-21', masterRowFill: 'FFCAEDFB' },
      { name: '22-28.06', start: '2026-06-22', end: '2026-06-28', masterRowFill: 'FFC1F0C8' },
    ],
    weeklyHeaderFill: 'FFC0E6F5',
    // Weekly sheets color only the completed-time cell (column M). Distinct completed dates
    // found in a sheet, ordered oldest-first, cycle through this palette; the same date always
    // gets the same color. This is a configured fill, not Excel conditional formatting.
    weeklyDateFills: [
      'FFDAF2D0',
      'FFF2CEEF',
      'FFCAEDFB',
      'FF83E28E',
      'FFE49EDD',
      'FFF4B183',
      'FFFFD966',
    ],
    comments: {
      // Verbatim from the full specification §13. Kept as single strings; the renderer wraps
      // them into the cell note as-is.
      masterL1:
        'รายได้สุทธิ = ราคาขายสุทธิ - ส่วนลดที่ผู้ขายชำระ - ค่าคอมมิชชั่น - Transaction Fee; raw file ไม่มีค่าคอมมิชชั่น ASM',
      weeklyL2: 'สูตร =H-I-J-K; raw file ไม่มีค่าคอมมิชชั่น ASM',
    },
    geometry: {
      master: {
        // Column widths A:M, exact from spec §11.
        widths: [16.9, 14.6, 47.1, 16.8, 8.1, 8.1, 10.7, 9.9, 10.5, 8.1, 8.1, 8.1, 17.2],
        rowHeights: { header: 48.6, data: 33.6 },
        zoom: 90,
        print: { orientation: 'portrait', paperSize: 9, scale: 100 },
      },
      weekly: {
        // Column widths A:M, exact from spec §12.
        widths: [13.7, 11.8, 41.6, 16.8, 8.1, 8.1, 11.6, 8.1, 11.8, 8.1, 8.1, 10.1, 15.3],
        rowHeights: { period: 19.8, header: 45.6, data: 39.0 },
        zoom: 100,
        print: { orientation: 'landscape', paperSize: 9, fitToWidth: 1, fitToHeight: 0 },
      },
    },
  },
};

// Derive the YYYY-MM lookup key from an ISO date string (YYYY-MM-DD). Returns '' if the input
// is not a parseable ISO date.
function monthKeyFromIsoDate(isoDate) {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(isoDate || '').trim());
  return match ? `${match[1]}-${match[2]}` : '';
}

// Resolve the accounting-cycle profile for a Shopee export. The cycle is identified by the
// upload filename's period start month (the export filename is the authoritative cycle marker
// because a valid report range can include boundary days with no orders). Throws a 400 if no
// verified profile exists for that month — never returns null and never falls back to another
// cycle's rules.
function resolveCycleProfile({ filenamePeriodStart } = {}) {
  const monthKey = monthKeyFromIsoDate(filenamePeriodStart);
  const profile = monthKey ? MONTH_PROFILES[monthKey] : null;

  if (!profile) {
    throw badRequest(
      `No verified Shopee accounting-cycle configuration for period ${monthKey || '(unknown)'}. ` +
        'Only cycles with an approved, hand-verified profile can be processed.',
      { requestedMonthKey: monthKey || null },
    );
  }

  return { profile };
}

module.exports = {
  MONTH_PROFILES,
  monthKeyFromIsoDate,
  resolveCycleProfile,
};
