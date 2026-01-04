const API_BASE = "https://sc-official-website.onrender.com";

const form = document.getElementById("signupForm");
const otpBox = document.getElementById("otpBox");
const verifyBtn = document.getElementById("verifyBtn");
const msg = document.getElementById("msg");

const fullNameEl = document.getElementById("fullName");
const emailEl = document.getElementById("email");
const passwordEl = document.getElementById("password");
const phoneEl = document.getElementById("phoneNumber");
const confirmPasswordEl = document.getElementById("confirmPassword");
const otpEl = document.getElementById("otp");
const submitBtn = document.getElementById("form-submit");

let savedEmail = "";
let savedPhone = "";

function setMsg(text, isError = false) {
  msg.textContent = text;
  msg.style.color = isError ? "crimson" : "inherit";
  msg.classList.toggle("is-error", isError);

  // retrigger shake animation for errors
  if (isError) {
    msg.classList.remove("shake");
    // force reflow
    void msg.offsetWidth;
    msg.classList.add("shake");
  }
}

function cleanDigits(value, maxLen = 10) {
  return (value || "").replace(/\D/g, "").slice(0, maxLen);
}

function formatThaiPhone(rawDigits) {
  if (!rawDigits) return "";
  const digits = cleanDigits(rawDigits);

  // mobile: 06/08/09 + 8 digits -> xxx-xxx-xxxx
  if (digits.length >= 3 && ["6", "8", "9"].includes(digits[1])) {
    return [
      digits.slice(0, 3),
      digits.slice(3, 6),
      digits.slice(6, 10),
    ]
      .filter(Boolean)
      .join("-");
  }

  // landline: 0x + 7-8 digits -> xx-xxx-xxxx (assume 2-digit area code)
  return [
    digits.slice(0, 2),
    digits.slice(2, 5),
    digits.slice(5, 9),
  ]
    .filter(Boolean)
    .join("-");
}

function isValidThaiPhone(value) {
  const digits = cleanDigits(value);
  const isMobile = /^0[689]\d{8}$/.test(digits);
  // allow 9-digit landline starting with 02-07
  const isLandline = /^0[2-7]\d{7}$/.test(digits);
  return isMobile || isLandline;
}

function isValidEmail(email) {
  if (!email) return false;
  const trimmed = email.trim();
  const basicPattern = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
  if (!basicPattern.test(trimmed)) return false;

  const domain = trimmed.split("@")[1];
  if (!domain || domain.includes("..")) return false;
  const parts = domain.split(".");
  return parts.every((part) => part && !part.startsWith("-") && !part.endsWith("-"));
}

function isStrongPassword(pwd) {
  if (!pwd) return false;
  const strongPattern = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,30}$/;
  return strongPattern.test(pwd);
}

function validateAllFields() {
  const fullName = fullNameEl.value.trim();
  const email = emailEl.value.trim();
  const password = passwordEl.value;
  const confirmPassword = confirmPasswordEl.value;
  const phoneDigits = cleanDigits(phoneEl.value);

  if (!fullName || !email || !password || !confirmPassword || !phoneDigits) {
    return { ok: false, message: "กรอกข้อมูลให้ครบทุกช่องก่อนดำเนินการ" };
  }

  if (!isValidThaiPhone(phoneDigits)) {
    return {
      ok: false,
      message: "กรุณากรอกเบอร์โทรศัพท์ไทยให้ถูกต้อง (มือถือ 10 หลัก หรือเบอร์บ้าน 9 หลัก)",
    };
  }

  if (!isValidEmail(email)) {
    return { ok: false, message: "กรุณากรอกอีเมล์ที่โดเมนใช้งานได้จริง" };
  }

  if (!isStrongPassword(password)) {
    return {
      ok: false,
      message: "รหัสผ่านต้องยาว 8-30 ตัว และมีตัวพิมพ์ใหญ่ พิมพ์เล็ก และตัวเลข",
    };
  }

  if (confirmPassword !== password) {
    return { ok: false, message: "รหัสผ่านและยืนยันรหัสผ่านต้องตรงกัน" };
  }

  return { ok: true, cleanedPhone: phoneDigits };
}

function lockSubmit(disabled) {
  if (!submitBtn) return;
  submitBtn.disabled = disabled;
}

// live input helpers
phoneEl.addEventListener("input", () => {
  const digits = cleanDigits(phoneEl.value);
  phoneEl.value = formatThaiPhone(digits);
});

otpEl.addEventListener("input", () => {
  otpEl.value = cleanDigits(otpEl.value, 6);
});

// Step 1: send OTP (email only)
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  setMsg("");

  const validation = validateAllFields();
  if (!validation.ok) return setMsg(validation.message, true);

  const email = emailEl.value.trim();
  const fullName = fullNameEl.value.trim();
  const password = passwordEl.value;

  lockSubmit(true);

  try {
    setMsg("Sending verification code...");

    const r = await fetch(`${API_BASE}/api/auth/start-signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Failed to send code");

    savedEmail = email;
    savedPhone = validation.cleanedPhone;
    otpBox.style.display = "block";
    setMsg("✅ Code sent. Check your email and enter the 6-digit code.");
    alert("เราได้ส่งรหัสยืนยัน 6 หลัก ไปที่อีเมล์ของคุณแล้ว กรุณานำรหัสมาใส่และกดยืนยัน");
    otpEl.focus();
  } catch (err) {
    setMsg("❌ " + err.message, true);
  } finally {
    lockSubmit(false);
  }
});

// Step 2: verify OTP, then create account
verifyBtn.addEventListener("click", async () => {
  setMsg("");

  const validation = validateAllFields();
  if (!validation.ok) return setMsg(validation.message, true);

  const fullName = fullNameEl.value.trim();
  const password = passwordEl.value;
  const code = otpEl.value.trim();

  if (!savedEmail) return setMsg("Please request a code first.", true);
  if (!code) return setMsg("Enter the 6-digit code.", true);

  try {
    setMsg("Verifying code...");

    const r = await fetch(`${API_BASE}/api/auth/verify-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: savedEmail, code }),
    });

    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Verification failed");

    setMsg("✅ Email verified. Creating account...");

    const r2 = await fetch(`${API_BASE}/api/auth/finish-signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName,
        email: savedEmail,
        password,
        phoneNumber: savedPhone,
      }),
    });

    const data2 = await r2.json();
    if (!r2.ok) throw new Error(data2.error || "Finish signup failed");

    setMsg("✅ Account created! You can now log in.");
    window.location.href = "./login-form.html";
  } catch (err) {
    setMsg("❌ " + err.message, true);
  }
});
