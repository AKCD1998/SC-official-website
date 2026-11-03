'use strict';

// POS releases through 1.3.11 deserialize currentPoints into a non-nullable Int32.
// An unavailable Ada balance is not zero. Omit the optional numeric field while
// retaining the explicit availability/source metadata so both client generations
// can still display/select the member. No stored point balance is changed.
function memberResponse(member) {
  if (member.pointsAvailable !== false || member.currentPoints != null) return member;
  const { currentPoints, ...response } = member;
  return response;
}

module.exports = { memberResponse };
