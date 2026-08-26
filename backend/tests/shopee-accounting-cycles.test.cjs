const {
  addDays,
  buildCycleProfile,
  isApprovedCycleStart,
  latestCoveredCycleStart,
  resolveCycleProfile,
  toPublicCycle,
} = require('../src/modules/seamless/services/shopeeAccountingCycles');

test('builds the verified June cycle without changing its workbook contract', () => {
  const profile = buildCycleProfile('2026-06-01');

  expect(profile.periodEnd).toBe('2026-06-28');
  expect(profile.masterSheetName).toBe('06');
  expect(profile.weeks.map((week) => week.name)).toEqual([
    '01-07.06',
    '08-14.06',
    '15-21.06',
    '22-28.06',
  ]);
  expect(profile.weeks.map((week) => week.masterRowFill)).toEqual([
    'FFDAF2D0',
    'FFF2CEEF',
    'FFCAEDFB',
    'FFC1F0C8',
  ]);
});

test('builds July and August as consecutive four-week cycles with cross-month names', () => {
  const july = buildCycleProfile('2026-06-29');
  const august = buildCycleProfile('2026-07-27');

  expect(july.periodEnd).toBe('2026-07-26');
  expect(july.masterSheetName).toBe('07');
  expect(july.weeks.map((week) => week.name)).toEqual([
    '29.06-05.07',
    '06-12.07',
    '13-19.07',
    '20-26.07',
  ]);

  expect(august.periodEnd).toBe('2026-08-23');
  expect(august.masterSheetName).toBe('08');
  expect(august.weeks.map((week) => week.name)).toEqual([
    '27.07-02.08',
    '03-09.08',
    '10-16.08',
    '17-23.08',
  ]);
});

test('builds the active 24 August to 13 September cycle as three complete weeks', () => {
  const active = buildCycleProfile('2026-08-24');

  expect(active.periodEnd).toBe('2026-09-13');
  expect(active.masterSheetName).toBe('09');
  expect(active.weeks.map((week) => week.name)).toEqual([
    '24-30.08',
    '31.08-06.09',
    '07-13.09',
  ]);
  expect(buildCycleProfile('2026-09-14').periodEnd).toBe('2026-10-11');
});

test('supports cycles before the anchor only when they stay on the same 28-day sequence', () => {
  expect(isApprovedCycleStart('2026-05-04')).toBe(true);
  expect(buildCycleProfile('2026-05-04').periodEnd).toBe('2026-05-31');
  expect(isApprovedCycleStart('2026-05-01')).toBe(false);
  expect(() => buildCycleProfile('2026-05-01')).toThrow(/approved accounting-cycle boundary/);
});

test('public cycle exposes exact ICT download boundaries and four auditable weeks', () => {
  const publicCycle = toPublicCycle(buildCycleProfile(addDays('2026-07-26', 1)));

  expect(publicCycle.downloadFromIct).toBe('2026-07-27T00:00:00+07:00');
  expect(publicCycle.downloadToIct).toBe('2026-08-23T23:59:59+07:00');
  expect(publicCycle.downloadGuidance.preferredFilterField).toBe('order_created_at');
  expect(publicCycle.downloadGuidance.preferredFromIct).toBe('2026-07-27T00:00:00+07:00');
  expect(publicCycle.downloadGuidance.accountingFilterField).toBe('order_created_at');
  expect(publicCycle.downloadGuidance.orderDateWindow).toEqual({
    filterField: 'order_created_at',
    fromIct: '2026-07-27T00:00:00+07:00',
    toIct: '2026-08-23T23:59:59+07:00',
    guaranteedComplete: true,
  });
  expect(publicCycle.downloadGuidance.orderDateFallback).toEqual({
    filterField: 'order_created_at',
    minimumLookbackDays: 0,
    fromIct: '2026-07-27T00:00:00+07:00',
    toIct: '2026-08-23T23:59:59+07:00',
    guaranteedComplete: true,
  });
  expect(publicCycle.weeks).toHaveLength(4);
  expect(publicCycle.weeks[3]).toEqual({
    name: '17-23.08',
    start: '2026-08-17',
    end: '2026-08-23',
  });
});

test('selects the latest fully covered cycle from the filename end and accepts a lookback start', () => {
  expect(latestCoveredCycleStart('2026-07-31')).toBe('2026-06-29');
  expect(latestCoveredCycleStart('2026-09-13')).toBe('2026-08-24');
  expect(latestCoveredCycleStart('2026-10-10')).toBe('2026-08-24');
  expect(latestCoveredCycleStart('2026-10-11')).toBe('2026-09-14');
  expect(
    resolveCycleProfile({
      filenamePeriodStart: '2026-06-01',
      filenamePeriodEnd: '2026-07-31',
    }).profile.cycleKey,
  ).toBe('2026-06-29_to_2026-07-26');
  expect(
    resolveCycleProfile({
      filenamePeriodStart: '2026-08-24',
      filenamePeriodEnd: '2026-09-13',
    }).profile.cycleKey,
  ).toBe('2026-08-24_to_2026-09-13');
});

test('rejects a filename range that starts after the selected accounting cycle begins', () => {
  expect(() => resolveCycleProfile({
    filenamePeriodStart: '2026-07-01',
    filenamePeriodEnd: '2026-07-31',
  })).toThrow(/must cover the complete accounting cycle 2026-06-29\.\.2026-07-26/);
});
