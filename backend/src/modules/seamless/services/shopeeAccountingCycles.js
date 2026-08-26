const { badRequest } = require('../errors');

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS_PER_WEEK = 7;
const WEEKS_PER_CYCLE = 4;
const DAYS_PER_CYCLE = DAYS_PER_WEEK * WEEKS_PER_CYCLE;

// Historical reports through 2026-08-23 use four-week blocks anchored to the verified June
// workbook. Accounting reset the active cycle to a three-week period on 2026-08-24 so that it
// closes on 2026-09-13; standard four-week periods resume from 2026-09-14. Both membership and
// weekly allocation use Shopee's order-created timestamp.
const CYCLE_ANCHOR_START = '2026-06-01';
const OPERATIONAL_CYCLE_START = '2026-08-24';
const NEXT_STANDARD_CYCLE_START = '2026-09-14';
const CYCLE_WEEK_OVERRIDES = Object.freeze({
  [OPERATIONAL_CYCLE_START]: 3,
});

const MASTER_ROW_FILLS = [
  'FFDAF2D0',
  'FFF2CEEF',
  'FFCAEDFB',
  'FFC1F0C8',
];

const WEEKLY_DATE_FILLS = [
  'FFDAF2D0',
  'FFF2CEEF',
  'FFCAEDFB',
  'FF83E28E',
  'FFE49EDD',
  'FFF4B183',
  'FFFFD966',
];

const SHARED_PROFILE = {
  cancelledStatus: 'ยกเลิกแล้ว',
  weeklyHeaderFill: 'FFC0E6F5',
  weeklyDateFills: WEEKLY_DATE_FILLS,
  comments: {
    masterL1:
      'รายได้สุทธิ = ราคาขายสุทธิ - ส่วนลดที่ผู้ขายชำระ - ค่าคอมมิชชั่น - Transaction Fee; raw file ไม่มีค่าคอมมิชชั่น ASM',
    weeklyL2: 'สูตร =H-I-J-K; raw file ไม่มีค่าคอมมิชชั่น ASM',
  },
  geometry: {
    master: {
      // B and M both render typed Excel datetimes with the same yyyy-mm-dd hh:mm format.
      // Keep B as wide as M; the narrower June-reference width only worked while B was text
      // and renders typed dates as ######## in desktop Excel/PDF output.
      widths: [16.9, 17.2, 47.1, 16.8, 8.1, 8.1, 10.7, 9.9, 10.5, 8.1, 8.1, 8.1, 17.2],
      rowHeights: { header: 48.6, data: 33.6 },
      zoom: 90,
      print: { orientation: 'portrait', paperSize: 9, scale: 100 },
    },
    weekly: {
      widths: [13.7, 15.3, 41.6, 16.8, 8.1, 8.1, 11.6, 8.1, 11.8, 8.1, 8.1, 10.1, 15.3],
      rowHeights: { period: 19.8, header: 45.6, data: 39.0 },
      zoom: 100,
      print: { orientation: 'landscape', paperSize: 9, fitToWidth: 1, fitToHeight: 0 },
    },
  },
};

function parseIsoDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return timestamp;
}

function formatIsoDay(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  const timestamp = parseIsoDay(isoDate);
  return timestamp === null ? '' : formatIsoDay(timestamp + Number(days) * DAY_MS);
}

function cycleOffsetDays(isoDate, anchorStart = CYCLE_ANCHOR_START) {
  const timestamp = parseIsoDay(isoDate);
  const anchor = parseIsoDay(anchorStart);
  return timestamp === null ? null : Math.round((timestamp - anchor) / DAY_MS);
}

function isApprovedCycleStart(isoDate) {
  const normalized = String(isoDate || '').trim();
  const anchor = normalized >= NEXT_STANDARD_CYCLE_START
    ? NEXT_STANDARD_CYCLE_START
    : CYCLE_ANCHOR_START;
  const offset = cycleOffsetDays(normalized, anchor);
  return offset !== null && offset % DAYS_PER_CYCLE === 0;
}

function latestCoveredCycleStart(periodEnd) {
  const endTimestamp = parseIsoDay(periodEnd);
  if (endTimestamp === null) return '';

  const operationalEnd = addDays(
    OPERATIONAL_CYCLE_START,
    CYCLE_WEEK_OVERRIDES[OPERATIONAL_CYCLE_START] * DAYS_PER_WEEK - 1,
  );
  const nextStandardEnd = addDays(NEXT_STANDARD_CYCLE_START, DAYS_PER_CYCLE - 1);

  if (periodEnd >= operationalEnd && periodEnd < nextStandardEnd) {
    return OPERATIONAL_CYCLE_START;
  }

  const sequenceAnchor = periodEnd >= nextStandardEnd
    ? NEXT_STANDARD_CYCLE_START
    : CYCLE_ANCHOR_START;
  const anchorTimestamp = parseIsoDay(sequenceAnchor);
  const daysFromAnchor = Math.floor((endTimestamp - anchorTimestamp) / DAY_MS);
  const cycleIndex = Math.floor((daysFromAnchor - (DAYS_PER_CYCLE - 1)) / DAYS_PER_CYCLE);
  return addDays(sequenceAnchor, cycleIndex * DAYS_PER_CYCLE);
}

function weekName(start, end) {
  const [, startMonth, startDay] = start.split('-');
  const [, endMonth, endDay] = end.split('-');

  return startMonth === endMonth
    ? `${startDay}-${endDay}.${endMonth}`
    : `${startDay}.${startMonth}-${endDay}.${endMonth}`;
}

function buildCycleProfile(periodStart) {
  if (!isApprovedCycleStart(periodStart)) {
    throw badRequest(
      `Shopee accounting period must start on an approved accounting-cycle boundary; received ${periodStart || '(unknown)'}.`,
      {
        anchorPeriodStart: CYCLE_ANCHOR_START,
        operationalPeriodStart: OPERATIONAL_CYCLE_START,
        requestedPeriodStart: periodStart || null,
      },
    );
  }

  const weekCount = CYCLE_WEEK_OVERRIDES[periodStart] || WEEKS_PER_CYCLE;
  const periodEnd = addDays(periodStart, weekCount * DAYS_PER_WEEK - 1);
  const weeks = Array.from({ length: weekCount }, (_, index) => {
    const start = addDays(periodStart, index * DAYS_PER_WEEK);
    const end = addDays(start, DAYS_PER_WEEK - 1);
    return {
      name: weekName(start, end),
      start,
      end,
      masterRowFill: MASTER_ROW_FILLS[index],
    };
  });

  return {
    cycleKey: `${periodStart}_to_${periodEnd}`,
    cycleLabel: `${periodStart}..${periodEnd}`,
    periodStart,
    periodEnd,
    masterSheetName: periodEnd.slice(5, 7),
    weeks,
    ...SHARED_PROFILE,
  };
}

function nextCycleStart(periodStart) {
  return addDays(buildCycleProfile(periodStart).periodEnd, 1);
}

// Backwards-compatible export for the original June verification tests and any read-only
// diagnostics that still inspect the known reference profile directly.
const MONTH_PROFILES = {
  '2026-06': buildCycleProfile(CYCLE_ANCHOR_START),
};

function monthKeyFromIsoDate(isoDate) {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(isoDate || '').trim());
  return match ? `${match[1]}-${match[2]}` : '';
}

function resolveCycleProfile({ filenamePeriodStart, filenamePeriodEnd } = {}) {
  const sourceStart = String(filenamePeriodStart || '').trim();
  const sourceEnd = String(filenamePeriodEnd || '').trim();
  const periodStart = latestCoveredCycleStart(sourceEnd);

  if (parseIsoDay(sourceStart) === null || !periodStart) {
    throw badRequest('Shopee source filename must contain a valid start and end date range.', {
      filenamePeriodStart: sourceStart || null,
      filenamePeriodEnd: sourceEnd || null,
    });
  }

  const profile = buildCycleProfile(periodStart);
  if (sourceStart > profile.periodStart || sourceEnd < profile.periodEnd) {
    throw badRequest(
      `Shopee source filename range ${sourceStart}..${sourceEnd} must cover the complete accounting cycle ${profile.periodStart}..${profile.periodEnd}.`,
      {
        accountingPeriodStart: profile.periodStart,
        accountingPeriodEnd: profile.periodEnd,
        filenamePeriodStart: sourceStart,
        filenamePeriodEnd: sourceEnd,
      },
    );
  }

  return { profile };
}

function toPublicCycle(profile) {
  const orderDateWindowFromIct = `${profile.periodStart}T00:00:00+07:00`;
  const orderDateWindowToIct = `${profile.periodEnd}T23:59:59+07:00`;

  return {
    cycleKey: profile.cycleKey,
    periodStart: profile.periodStart,
    periodEnd: profile.periodEnd,
    masterSheetName: profile.masterSheetName,
    weeks: profile.weeks.map(({ name, start, end }) => ({ name, start, end })),
    downloadFromIct: orderDateWindowFromIct,
    downloadToIct: orderDateWindowToIct,
    orderDateWindowFromIct,
    orderDateWindowToIct,
    downloadGuidance: {
      preferredFilterField: 'order_created_at',
      preferredFromIct: orderDateWindowFromIct,
      preferredToIct: orderDateWindowToIct,
      accountingFilterField: 'order_created_at',
      orderDateWindow: {
        filterField: 'order_created_at',
        fromIct: orderDateWindowFromIct,
        toIct: orderDateWindowToIct,
        guaranteedComplete: true,
      },
      // Deprecated response alias retained while deployed clients roll forward.
      orderDateFallback: {
        filterField: 'order_created_at',
        minimumLookbackDays: 0,
        fromIct: orderDateWindowFromIct,
        toIct: orderDateWindowToIct,
        guaranteedComplete: true,
      },
    },
  };
}

module.exports = {
  CYCLE_ANCHOR_START,
  DAYS_PER_CYCLE,
  MONTH_PROFILES,
  NEXT_STANDARD_CYCLE_START,
  OPERATIONAL_CYCLE_START,
  WEEKS_PER_CYCLE,
  addDays,
  buildCycleProfile,
  isApprovedCycleStart,
  latestCoveredCycleStart,
  monthKeyFromIsoDate,
  nextCycleStart,
  resolveCycleProfile,
  toPublicCycle,
  weekName,
};
