const CONSENT_VERSION = "qr-v1.0";
const { registrationReferral } = require('./registrationReferrals');

function normalizeThaiPhone(value) {
  if (typeof value !== "string" || value.length > 40) return "";
  const ascii = value.replace(/[๐-๙]/g, (digit) => String(digit.charCodeAt(0) - 0x0e50));
  if (!/^[\d+\s()-]+$/.test(ascii)) return "";
  let phone = ascii.replace(/[\s()-]/g, "");
  if (phone.startsWith("+66")) phone = `0${phone.slice(3)}`;
  else if (phone.startsWith("0066")) phone = `0${phone.slice(4)}`;
  return /^0[689][0-9]{8}$/.test(phone) ? phone : "";
}

function normalizeName(value) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f<>]/.test(value)) return "";
  const name = value.normalize("NFC").trim().replace(/\s+/g, " ");
  return name.length <= 100 && /\p{L}/u.test(name) ? name : "";
}

function validatePublicRegistration(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "กรุณากรอกข้อมูลให้ครบถ้วน" };
  }
  const firstName = normalizeName(body.firstName);
  const lastName = normalizeName(body.lastName);
  const phone = normalizeThaiPhone(body.phone);
  if (!firstName) return { error: "กรุณากรอกชื่อให้ถูกต้อง (ไม่เกิน 100 ตัวอักษร)", field: "firstName" };
  if (!lastName) return { error: "กรุณากรอกนามสกุลให้ถูกต้อง (ไม่เกิน 100 ตัวอักษร)", field: "lastName" };
  if (!phone) return { error: "กรุณากรอกมือถือไทย 10 หลัก ขึ้นต้น 06, 08 หรือ 09", field: "phone" };
  if (body.consent !== true) return { error: "กรุณายินยอมให้เก็บข้อมูลเพื่อสมัครสมาชิก", field: "consent" };
  if (Object.hasOwn(body, 'referralCode')) {
    const referral = registrationReferral(body.referralCode);
    if (!referral) return { error: "ลิงก์สมัครสมาชิกไม่ถูกต้อง กรุณาสแกน QR ที่ร้านอีกครั้ง", field: "referralCode" };
    // Resolve again on submit; posted branch/POS cannot override a referral.
    return { value: { fullName: `${firstName} ${lastName}`, phone, ...referral } };
  }
  // Old QR pages can still submit without a branch; these stay unattributed.
  if (body.branchCode != null && body.branchCode !== '' && !['001', '003', '004', '005'].includes(body.branchCode)) {
    return { error: "กรุณาเลือกสาขาที่สมัครให้ถูกต้อง", field: "branchCode" };
  }
  return { value: { fullName: `${firstName} ${lastName}`, phone, branchCode: body.branchCode || null } };
}

module.exports = { CONSENT_VERSION, normalizeThaiPhone, validatePublicRegistration };
