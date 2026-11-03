const { memberResponse } = require('../lib/memberResponse');

test.each(['unknown', 'stale', 'source_unavailable'])('unavailable %s balances keep the identity and status without an Int32-incompatible null', status => {
  const original = { id: 'member-fixture', memberCode: 'AR001-000662', displayName: 'Fixture',
    currentPoints: null, pointsAvailable: false, pointsSource: 'ada', pointsStatus: status, balanceExact: null };
  const response = memberResponse(original);
  expect(response).toEqual({ id: original.id, memberCode: original.memberCode, displayName: original.displayName,
    pointsAvailable: false, pointsSource: 'ada', pointsStatus: status, balanceExact: null });
  expect(original.currentPoints).toBeNull();
});

test.each([0, 23713, -1, 51.5])('a verified balance %s remains exact rather than being hidden or replaced', points => {
  const member = { currentPoints: points, pointsAvailable: true, balanceExact: String(points), pointsSource: 'ada' };
  expect(memberResponse(member)).toBe(member);
});

test('pre-Ada preview and points-disabled numeric responses retain their existing contract', () => {
  const member = { id: 'fixture', currentPoints: 0, pointsAvailable: false };
  expect(memberResponse(member)).toBe(member);
});
