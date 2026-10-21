"use strict";

const form = document.getElementById("member-form");
const submit = document.getElementById("submit");
const errorElement = document.getElementById("error");
let submitting = false;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submitting || !form.reportValidity()) return;
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
