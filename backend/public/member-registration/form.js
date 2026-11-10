"use strict";

const form = document.getElementById("member-form");
const submit = document.getElementById("submit");
const errorElement = document.getElementById("error");
let submitting = false;
const branch = new URLSearchParams(location.search).get('branch');
const referralCode = form.elements.referralCode?.value;
if (!referralCode && ['001', '003', '004', '005'].includes(branch)) form.elements.branchCode.value = branch;
const phoneInput = form.elements.phone;
const phoneHint = "กรุณากรอกมือถือไทย 10 หลัก ขึ้นต้น 06, 08 หรือ 09";

function normalizedMobile(value) {
  const ascii = value.replace(/[๐-๙]/g, digit => String(digit.charCodeAt(0) - 0x0e50));
  if (!/^[\d+\s()-]+$/.test(ascii)) return "";
  let phone = ascii.replace(/[\s()-]/g, "");
  if (phone.startsWith("+66")) phone = `0${phone.slice(3)}`;
  else if (phone.startsWith("0066")) phone = `0${phone.slice(4)}`;
  return /^0[689][0-9]{8}$/.test(phone) ? phone : "";
}

// Normalize formatted input before explicitly running all HTML constraints.
form.noValidate = true;
phoneInput.addEventListener("input", () => {
  phoneInput.setCustomValidity(normalizedMobile(phoneInput.value) ? "" : phoneHint);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submitting) return;
  const phone = normalizedMobile(phoneInput.value);
  phoneInput.setCustomValidity(phone ? "" : phoneHint);
  if (phone) phoneInput.value = phone;
  if (!form.reportValidity()) return;
  errorElement.hidden = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  submitting = true;
  submit.disabled = true;
  submit.textContent = "กำลังบันทึกข้อมูล…";
  form.setAttribute("aria-busy", "true");
  try {
    const response = await fetch("/join/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
      body: JSON.stringify({
        firstName: form.elements.firstName.value.trim(),
        lastName: form.elements.lastName.value.trim(),
        phone: form.elements.phone.value.trim(),
        consent: form.elements.consent.checked,
        branchCode: form.elements.branchCode.value,
        ...(referralCode ? { referralCode } : {}),
      }),
    });
    let result;
    try { result = await response.json(); } catch { throw new Error("ระบบตอบกลับไม่สมบูรณ์ กรุณาลองใหม่อีกครั้ง"); }
    if (!response.ok || result.ok !== true) {
      if (result.field && form.elements[result.field]) form.elements[result.field].focus();
      throw new Error(result.error || "ยังบันทึกข้อมูลไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    }
    form.reset();
    document.getElementById("registration").hidden = true;
    const success = document.getElementById("success");
    success.hidden = false;
    success.focus();
  } catch (error) {
    errorElement.textContent = error.name === "AbortError"
      ? "ยังไม่ได้รับการยืนยันจากระบบ กรุณาลองส่งอีกครั้ง ข้อมูลจะไม่ถูกสร้างซ้ำ"
      : error instanceof TypeError ? "เชื่อมต่อไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่" : error.message;
    errorElement.hidden = false;
  } finally {
    clearTimeout(timeout);
    submitting = false;
    submit.disabled = false;
    submit.textContent = "ยืนยันสมัครสมาชิก →";
    form.removeAttribute("aria-busy");
  }
});
