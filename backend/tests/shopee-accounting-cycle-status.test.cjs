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

test('finds the highest cycle that is continuous from the anchor, regardless of upload order', () => {
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

test('does not advance past a missing July cycle when June and August exist', () => {
  const history = analyzeCycleHistory([
    summary('2026-06-01', '2026-06-28'),
    summary('2026-07-27', '2026-08-23'),
  ]);

  expect(history.lastContinuousCycle.periodEnd).toBe('2026-06-28');
  expect(history.nextCycle.periodStart).toBe('2026-06-29');
  expect(history.missingCycles.map((cycle) => cycle.cycleKey)).toEqual([
    '2026-06-29_to_2026-07-26',
  ]);
  expect(history.futureCompletedCycles.map((cycle) => cycle.cycleKey)).toEqual([
    '2026-07-27_to_2026-08-23',
  ]);
});

test('returns the next four-week cycle after continuous stored Shopee workbooks', async () => {
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
  expect(status.nextCycle.periodStart).toBe('2026-07-27');
  expect(status.nextCycle.periodEnd).toBe('2026-08-23');
  expect(status.nextCycle.weeks.map((week) => week.name)).toEqual([
    '27.07-02.08',
    '03-09.08',
    '10-16.08',
    '17-23.08',
  ]);
  expect(status.nextCycle.downloadGuidance.orderDateFallback.minimumLookbackDays).toBe(28);
  expect(status.nextCycle.downloadGuidance.orderDateFallback.fromIct).toBe(
    '2026-06-29T00:00:00+07:00',
  );
});

test('reports missing and already-uploaded future cycles without moving the checkpoint', async () => {
  listCycleSummariesMock.mockResolvedValue([
    summary('2026-06-01', '2026-06-28'),
    summary('2026-07-27', '2026-08-23'),
  ]);

  const status = await getShopeeAccountingCycleStatus();

  expect(status.hasGaps).toBe(true);
  expect(status.lastCompletedCycle.periodEnd).toBe('2026-06-28');
  expect(status.nextCycle.periodStart).toBe('2026-06-29');
  expect(status.missingCycles.map((cycle) => cycle.periodStart)).toEqual(['2026-06-29']);
  expect(status.futureCompletedCycles.map((cycle) => cycle.periodStart)).toEqual(['2026-07-27']);
});

test('zero-row output requires review and never closes or advances a cycle', async () => {
  listCycleSummariesMock.mockResolvedValue([
    summary('2026-06-01', '2026-06-28'),
    summary('2026-06-29', '2026-07-26', {
      finalRows: 0,
      checkpointEligible: false,
      cycleClosureStatus: 'review_required_empty',
    }),
  ]);

  const status = await getShopeeAccountingCycleStatus();

  expect(status.lastCompletedCycle.periodEnd).toBe('2026-06-28');
  expect(status.nextCycle.periodStart).toBe('2026-06-29');
  expect(status.unconfirmedEmptyCycles.map((cycle) => cycle.periodStart)).toEqual(['2026-06-29']);
});

test('a later valid upload clears the empty-cycle warning for the same cycle', async () => {
  listCycleSummariesMock.mockResolvedValue([
    summary('2026-06-01', '2026-06-28'),
    summary('2026-06-29', '2026-07-26', {
      finalRows: 0,
      checkpointEligible: false,
      cycleClosureStatus: 'review_required_empty',
    }),
    summary('2026-06-29', '2026-07-26', { finalRows: 46 }),
  ]);

  const status = await getShopeeAccountingCycleStatus();

  expect(status.lastCompletedCycle.periodEnd).toBe('2026-07-26');
  expect(status.unconfirmedEmptyCycles).toEqual([]);
});

test('falls back to the approved June anchor when no valid cycle history exists', async () => {
  listCycleSummariesMock.mockResolvedValue([{ periodStart: '', periodEnd: '' }]);

  const status = await getShopeeAccountingCycleStatus();

  expect(status.hasHistory).toBe(false);
  expect(status.hasGaps).toBe(false);
  expect(status.lastCompletedCycle).toBeNull();
  expect(status.nextCycle.periodStart).toBe('2026-06-01');
  expect(status.nextCycle.periodEnd).toBe('2026-06-28');
});
