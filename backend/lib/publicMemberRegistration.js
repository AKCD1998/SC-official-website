const CONSENT_VERSION = "qr-v1.0";

function normalizeThaiPhone(value) {
  if (typeof value !== "string" || value.length > 40) return "";
  const ascii = value.replace(/[๐-๙]/g, (digit) => String(digit.charCodeAt(0) - 0x0e50));
  if (!/^[\d+\s()-]+$/.test(ascii)) return "";
  let phone = ascii.replace(/[\s()-]/g, "");
  if (phone.startsWith("+66")) phone = `0${phone.slice(3)}`;
  else if (phone.startsWith("0066")) phone = `0${phone.slice(4)}`;
  return /^0\d{8,9}$/.test(phone) ? phone : "";
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
  if (!phone) return { error: "กรุณากรอกเบอร์โทรศัพท์ไทย 9–10 หลักให้ถูกต้อง", field: "phone" };
  if (body.consent !== true) return { error: "กรุณายินยอมให้เก็บข้อมูลเพื่อสมัครสมาชิก", field: "consent" };
  return { value: { fullName: `${firstName} ${lastName}`, phone } };
}

module.exports = { CONSENT_VERSION, normalizeThaiPhone, validatePublicRegistration };
