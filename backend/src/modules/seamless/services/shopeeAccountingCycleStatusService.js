const processingRecords = require('../processingRecords');
const {
  OPERATIONAL_CYCLE_START,
  buildCycleProfile,
  nextCycleStart,
  toPublicCycle,
} = require('./shopeeAccountingCycles');

function summaryFromValue(value) {
  return value?.metadata?.transformSummary || value || {};
}

function parseBoolean(value) {
  if (value === true || value === false) return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return null;
}

function parseExplicitRowCount(summary) {
  const raw = summary.finalRows ?? summary.rowCount;
  if (raw === null || typeof raw === 'undefined' || String(raw).trim() === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function observeCycle(value) {
  const summary = summaryFromValue(value);
  const periodStart = String(summary.periodStart || '').trim();
  const periodEnd = String(summary.periodEnd || '').trim();

  if (!periodStart || !periodEnd) return null;

  let profile;
  try {
    profile = buildCycleProfile(periodStart);
  } catch (error) {
    return null;
  }
  if (profile.periodEnd !== periodEnd) return null;

  const explicitRows = parseExplicitRowCount(summary);
  const explicitlyEligible = parseBoolean(summary.checkpointEligible);
  const closureStatus = String(summary.cycleClosureStatus || '').trim();
  const eligible =
    explicitlyEligible !== false &&
    closureStatus !== 'review_required_empty' &&
    (explicitRows === null || (Number.isFinite(explicitRows) && explicitRows > 0));

  return {
    profile,
    eligible,
    reason: eligible ? null : 'empty_cycle_requires_review',
  };
}

function cycleFromRecord(record) {
  const observation = observeCycle(record);
  return observation?.eligible ? observation.profile : null;
}

function uniqueProfiles(profiles) {
  const byKey = new Map();
  profiles.forEach((profile) => byKey.set(profile.cycleKey, profile));
  return Array.from(byKey.values()).sort((a, b) => a.periodStart.localeCompare(b.periodStart));
}

function analyzeCycleHistory(records) {
  const observations = (Array.isArray(records) ? records : []).map(observeCycle).filter(Boolean);
  const eligibleProfiles = uniqueProfiles(
    observations.filter((item) => item.eligible).map((item) => item.profile),
  );
  const eligibleKeys = new Set(eligibleProfiles.map((profile) => profile.cycleKey));
  const unconfirmedProfiles = uniqueProfiles(
    observations.filter((item) => !item.eligible).map((item) => item.profile),
  ).filter(
    (profile) =>
      profile.periodStart >= OPERATIONAL_CYCLE_START && !eligibleKeys.has(profile.cycleKey),
  );

  // Operational guidance follows the latest successfully processed cycle and never rewinds
  // staff to historical gaps. Older workbooks can still be uploaded manually, but their
  // absence does not move the displayed next cycle behind the configured operational start.
  const lastCompletedCycle = eligibleProfiles[eligibleProfiles.length - 1] || null;
  const candidateNextStart = lastCompletedCycle
    ? nextCycleStart(lastCompletedCycle.periodStart)
    : OPERATIONAL_CYCLE_START;
  const nextStart = candidateNextStart < OPERATIONAL_CYCLE_START
    ? OPERATIONAL_CYCLE_START
    : candidateNextStart;

  return {
    eligibleProfiles,
    lastCompletedCycle,
    // Retain these response fields for deployed-client compatibility. Operational guidance no
    // longer treats absent historical cycles as blockers.
    missingCycles: [],
    futureCompletedCycles: [],
    unconfirmedProfiles,
    nextCycle: buildCycleProfile(nextStart),
  };
}

function findLatestCompletedCycle(records) {
  return analyzeCycleHistory(records).lastCompletedCycle;
}

async function getShopeeAccountingCycleStatus() {
  const summaries = await processingRecords.listShopeeAccountingCycleSummaries();
  const history = analyzeCycleHistory(summaries);

  return {
    basis: 'latest_completed_cycle_with_operational_baseline',
    timezone: 'Asia/Bangkok',
    hasHistory: history.eligibleProfiles.length > 0,
    hasGaps: false,
    lastCompletedCycle: history.lastCompletedCycle
      ? toPublicCycle(history.lastCompletedCycle)
      : null,
    nextCycle: toPublicCycle(history.nextCycle),
    missingCycles: history.missingCycles.map(toPublicCycle),
    futureCompletedCycles: history.futureCompletedCycles.map(toPublicCycle),
    unconfirmedEmptyCycles: history.unconfirmedProfiles.map(toPublicCycle),
    dateFieldGuidance: {
      transformUses: 'order_created_at',
      preferredExportFilter: 'order_created_at',
      orderDateFallbackMinimumLookbackDays: 0,
      pendingCompletionPolicy: 'exclude_and_reupload_same_order_date_period',
      reconciliationPreferred: 'income_posted_at',
      message:
        'ตัวกรอง Order.all และตัวแปลงใช้วันที่ทำการสั่งซื้อเป็นเกณฑ์เดียวกันทั้งรอบและชีต ดาวน์โหลดช่วงรอบบัญชีตรง ๆ; รายการที่ยังไม่มีเวลาสั่งซื้อสำเร็จจะถูกพักไว้และต้อง export ช่วงเดิมซ้ำก่อนปิดรอบ',
    },
  };
}

module.exports = {
  analyzeCycleHistory,
  cycleFromRecord,
  findLatestCompletedCycle,
  getShopeeAccountingCycleStatus,
  observeCycle,
};
