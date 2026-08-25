const processingRecords = require('../processingRecords');
const {
  CYCLE_ANCHOR_START,
  addDays,
  buildCycleProfile,
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
  ).filter((profile) => profile.periodStart >= CYCLE_ANCHOR_START);
  const eligibleKeys = new Set(eligibleProfiles.map((profile) => profile.cycleKey));
  const unconfirmedProfiles = uniqueProfiles(
    observations.filter((item) => !item.eligible).map((item) => item.profile),
  ).filter(
    (profile) =>
      profile.periodStart >= CYCLE_ANCHOR_START && !eligibleKeys.has(profile.cycleKey),
  );

  const eligibleByStart = new Map(eligibleProfiles.map((profile) => [profile.periodStart, profile]));
  const latestObserved = eligibleProfiles[eligibleProfiles.length - 1] || null;
  const missingCycles = [];
  const futureCompletedCycles = [];
  let lastContinuousCycle = null;
  let gapFound = false;

  if (latestObserved) {
    for (
      let expectedStart = CYCLE_ANCHOR_START;
      expectedStart <= latestObserved.periodStart;
      expectedStart = addDays(expectedStart, 28)
    ) {
      const profile = eligibleByStart.get(expectedStart);
      if (!profile) {
        gapFound = true;
        missingCycles.push(buildCycleProfile(expectedStart));
      } else if (gapFound) {
        futureCompletedCycles.push(profile);
      } else {
        lastContinuousCycle = profile;
      }
    }
  }

  const nextStart = lastContinuousCycle
    ? addDays(lastContinuousCycle.periodEnd, 1)
    : CYCLE_ANCHOR_START;

  return {
    eligibleProfiles,
    lastContinuousCycle,
    missingCycles,
    futureCompletedCycles,
    unconfirmedProfiles,
    nextCycle: buildCycleProfile(nextStart),
  };
}

function findLatestCompletedCycle(records) {
  return analyzeCycleHistory(records).lastContinuousCycle;
}

async function getShopeeAccountingCycleStatus() {
  const summaries = await processingRecords.listShopeeAccountingCycleSummaries();
  const history = analyzeCycleHistory(summaries);

  return {
    basis: 'continuous_four_week_cycle',
    timezone: 'Asia/Bangkok',
    hasHistory: history.eligibleProfiles.length > 0,
    hasGaps: history.missingCycles.length > 0,
    lastCompletedCycle: history.lastContinuousCycle
      ? toPublicCycle(history.lastContinuousCycle)
      : null,
    nextCycle: toPublicCycle(history.nextCycle),
    missingCycles: history.missingCycles.map(toPublicCycle),
    futureCompletedCycles: history.futureCompletedCycles.map(toPublicCycle),
    unconfirmedEmptyCycles: history.unconfirmedProfiles.map(toPublicCycle),
    dateFieldGuidance: {
      transformUses: 'order_completed_at',
      preferredExportFilter: 'order_completed_at',
      orderDateFallbackMinimumLookbackDays: 28,
      reconciliationPreferred: 'income_posted_at',
      message:
        'ตัวแปลงใช้เวลาที่คำสั่งซื้อสำเร็จเป็นเกณฑ์ทั้งรอบและชีต หาก Shopee กรอง export ได้เฉพาะวันที่สั่งซื้อ ต้องดาวน์โหลดย้อนหลังอย่างน้อย 28 วันและรวมออเดอร์ค้างที่เก่ากว่านั้นด้วย; วันที่รายได้เข้าอาจไม่ตรงกันจึงยังต้องเทียบรายงานรายได้ก่อนปิดบัญชี',
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
