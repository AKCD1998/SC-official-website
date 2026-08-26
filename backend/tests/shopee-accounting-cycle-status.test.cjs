const listCycleSummariesMock = jest.fn();

jest.mock('../src/modules/seamless/processingRecords', () => ({
  listShopeeAccountingCycleSummaries: (...args) => listCycleSummariesMock(...args),
}));

const {
  analyzeCycleHistory,
  findLatestCompletedCycle,
  getShopeeAccountingCycleStatus,
} = require('../src/modules/seamless/services/shopeeAccountingCycleStatusService');

function summary(periodStart, periodEnd, overrides = {}) {
  return {
    periodStart,
    periodEnd,
    finalRows: 1,
    checkpointEligible: true,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('finds the latest completed cycle regardless of upload order', () => {
  const latest = findLatestCompletedCycle([
    summary('2026-07-27', '2026-08-23'),
    summary('2026-06-01', '2026-06-28'),
    summary('2026-06-29', '2026-07-26'),
    summary('2026-06-29', '2026-07-31'),
    {},
  ]);

  expect(latest.periodStart).toBe('2026-07-27');
  expect(latest.periodEnd).toBe('2026-08-23');
});

test('does not rewind to missing historical cycles when a later completed cycle exists', () => {
  const history = analyzeCycleHistory([
    summary('2026-06-01', '2026-06-28'),
    summary('2026-07-27', '2026-08-23'),
  ]);

  expect(history.lastCompletedCycle.periodEnd).toBe('2026-08-23');
  expect(history.nextCycle.periodStart).toBe('2026-08-24');
  expect(history.nextCycle.periodEnd).toBe('2026-09-13');
  expect(history.missingCycles).toEqual([]);
  expect(history.futureCompletedCycles).toEqual([]);
});

test('clamps historical history to the configured active cycle', async () => {
  listCycleSummariesMock.mockResolvedValue([
    summary('2026-06-01', '2026-06-28'),
    summary('2026-06-29', '2026-07-26'),
  ]);

  const status = await getShopeeAccountingCycleStatus();

  expect(listCycleSummariesMock).toHaveBeenCalledWith();
  expect(status.hasHistory).toBe(true);
  expect(status.hasGaps).toBe(false);
  expect(status.missingCycles).toEqual([]);
  expect(status.lastCompletedCycle.periodEnd).toBe('2026-07-26');
  expect(status.nextCycle.periodStart).toBe('2026-08-24');
  expect(status.nextCycle.periodEnd).toBe('2026-09-13');
  expect(status.nextCycle.weeks.map((week) => week.name)).toEqual([
    '24-30.08',
    '31.08-06.09',
    '07-13.09',
  ]);
  expect(status.nextCycle.downloadGuidance.orderDateFallback.minimumLookbackDays).toBe(0);
  expect(status.nextCycle.downloadGuidance.orderDateWindow.fromIct).toBe(
    '2026-08-24T00:00:00+07:00',
  );
  expect(status.dateFieldGuidance.preferredExportFilter).toBe('order_created_at');
  expect(status.dateFieldGuidance.transformUses).toBe('order_created_at');
  expect(status.dateFieldGuidance.pendingCompletionPolicy).toBe(
    'exclude_and_reupload_same_order_date_period',
  );
});

test('uses the latest stored cycle without requiring historical backfill', async () => {
  listCycleSummariesMock.mockResolvedValue([
    summary('2026-06-01', '2026-06-28'),
    summary('2026-07-27', '2026-08-23'),
  ]);

  const status = await getShopeeAccountingCycleStatus();

  expect(status.hasGaps).toBe(false);
  expect(status.lastCompletedCycle.periodEnd).toBe('2026-08-23');
  expect(status.nextCycle.periodStart).toBe('2026-08-24');
  expect(status.nextCycle.periodEnd).toBe('2026-09-13');
  expect(status.missingCycles).toEqual([]);
  expect(status.futureCompletedCycles).toEqual([]);
});

test('zero-row output requires review and never closes or advances a cycle', async () => {
  listCycleSummariesMock.mockResolvedValue([
    summary('2026-07-27', '2026-08-23'),
    summary('2026-08-24', '2026-09-13', {
      finalRows: 0,
      checkpointEligible: false,
      cycleClosureStatus: 'review_required_empty',
    }),
  ]);

  const status = await getShopeeAccountingCycleStatus();

  expect(status.lastCompletedCycle.periodEnd).toBe('2026-08-23');
  expect(status.nextCycle.periodStart).toBe('2026-08-24');
  expect(status.unconfirmedEmptyCycles.map((cycle) => cycle.periodStart)).toEqual(['2026-08-24']);
});

test('a later valid upload clears the empty-cycle warning for the same cycle', async () => {
  listCycleSummariesMock.mockResolvedValue([
    summary('2026-07-27', '2026-08-23'),
    summary('2026-08-24', '2026-09-13', {
      finalRows: 0,
      checkpointEligible: false,
      cycleClosureStatus: 'review_required_empty',
    }),
    summary('2026-08-24', '2026-09-13', { finalRows: 46 }),
  ]);

  const status = await getShopeeAccountingCycleStatus();

  expect(status.lastCompletedCycle.periodEnd).toBe('2026-09-13');
  expect(status.unconfirmedEmptyCycles).toEqual([]);
});

test('falls back to the configured active cycle when no valid history exists', async () => {
  listCycleSummariesMock.mockResolvedValue([{ periodStart: '', periodEnd: '' }]);

  const status = await getShopeeAccountingCycleStatus();

  expect(status.hasHistory).toBe(false);
  expect(status.hasGaps).toBe(false);
  expect(status.lastCompletedCycle).toBeNull();
  expect(status.nextCycle.periodStart).toBe('2026-08-24');
  expect(status.nextCycle.periodEnd).toBe('2026-09-13');
  expect(status.nextCycle.weeks).toHaveLength(3);
});

test('continues from 14 September after the configured three-week active cycle closes', async () => {
  listCycleSummariesMock.mockResolvedValue([
    summary('2026-08-24', '2026-09-13'),
  ]);

  const status = await getShopeeAccountingCycleStatus();

  expect(status.lastCompletedCycle.periodEnd).toBe('2026-09-13');
  expect(status.nextCycle.periodStart).toBe('2026-09-14');
  expect(status.nextCycle.periodEnd).toBe('2026-10-11');
  expect(status.nextCycle.weeks).toHaveLength(4);
});
