"use strict";

// Public source labels, never authentication credentials or customer identifiers.
// One form, eight approved POS origins. Never infer a branch from the client IP.
const REFERRALS = Object.freeze(Object.fromEntries(
  ['001', '003', '004', '005'].flatMap(branchCode => ['001', '002'].map(posCode => {
    const referralCode = `${branchCode}-${posCode}`;
    return [referralCode, Object.freeze({ referralCode, branchCode, posCode })];
  })),
));

function registrationReferral(code) {
  return typeof code === 'string' && Object.hasOwn(REFERRALS, code) ? REFERRALS[code] : null;
}

module.exports = { REFERRALS, registrationReferral };
