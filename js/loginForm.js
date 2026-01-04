const API_BASE = "https://sc-official-website.onrender.com";

// ===== Login =====
const loginForm = document.getElementById("loginForm");
const emailEl = document.getElementById("email");
const passEl = document.getElementById("password");
const msgEl = document.getElementById("msg");
const signUp = document.getElementById("goSignup");

// ===== Forgot/Reset UI =====
const loginWrap = document.getElementById("loginWrap");
const goForgot = document.getElementById("goForgot");
const forgotWrap = document.getElementById("otpForgotPass");
const resetWrap = document.getElementById("otpResetPass");

const fpEmailEl = document.getElementById("fpEmail");
const fpOtpEl = document.getElementById("fpOtp");
const fpSendBtn = document.getElementById("fpSendBtn");
const fpVerifyBtn = document.getElementById("fpVerifyBtn");
const fpMsgEl = document.getElementById("fpMsg");

const resetForm = document.getElementById("resetForm");
const fpNewPassEl = document.getElementById("fpNewPassword");
const fpConfirmPassEl = document.getElementById("fpConfirmPassword");
const fpResetMsgEl = document.getElementById("fpResetMsg");

let resetToken = null;

function setLoginMsg(text, isError = true) {
  msgEl.textContent = text;
  msgEl.style.color = isError ? "crimson" : "green";
}

function setFpMsg(text, isError = true) {
  fpMsgEl.textContent = text;
  fpMsgEl.style.color = isError ? "crimson" : "green";
}

function setResetMsg(text, isError = true) {
  fpResetMsgEl.textContent = text;
  fpResetMsgEl.style.color = isError ? "crimson" : "green";
}

function show(el){ el.style.display = "flex"; }
function hide(el){ el.style.display = "none"; }


function baseRepoUrl() {
  const repo = location.pathname.split("/")[1];
  return `${location.origin}/${repo}`;
}

// go signup (your old logic is fine)
if (signUp) {
  signUp.addEventListener("click", (e) => {
    e.preventDefault();
    window.location.href = `${baseRepoUrl()}/html/sign-up-form.html`;
  });
}

// login submit
if (loginForm) {
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    setLoginMsg("");

    const email = emailEl.value.trim();
    const password = passEl.value;

    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setLoginMsg(data.error || "Login failed");

      localStorage.setItem("token", data.token);
      setLoginMsg("Login success ✅", false);

      window.location.href = `${baseRepoUrl()}/#`;
    } catch (err) {
      console.error(err);
      setLoginMsg("Network error / server error");
    }
  });
}

// open forgot password box
if (goForgot) {
  goForgot.addEventListener("click", (e) => {
    e.preventDefault();
    setFpMsg("");
    hide(resetWrap);
    hide(loginWrap);
    show(forgotWrap);
    fpEmailEl.value = emailEl.value.trim(); // prefill from login email if typed
    fpEmailEl.focus();
  });
}

// send OTP
if (fpSendBtn) {
  fpSendBtn.addEventListener("click", async () => {
    setFpMsg("");

    const email = fpEmailEl.value.trim();
    if (!email) return setFpMsg("กรุณากรอกอีเมล์", true);

    try {
      setFpMsg("กำลังส่ง OTP...", false);
      const res = await fetch(`${API_BASE}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setFpMsg(data.error || "ส่ง OTP ไม่สำเร็จ", true);

      setFpMsg("ส่ง OTP แล้ว ✅ กรุณาเช็คอีเมล์", false);
      fpOtpEl.focus();
    } catch (err) {
      console.error(err);
      setFpMsg("Network error / server error", true);
    }
  });
}

// verify OTP -> get resetToken
if (fpVerifyBtn) {
  fpVerifyBtn.addEventListener("click", async () => {
    setFpMsg("");

    const email = fpEmailEl.value.trim();
    const otp = fpOtpEl.value.trim();
    if (!email) return setFpMsg("กรุณากรอกอีเมล์", true);
    if (!otp) return setFpMsg("กรุณากรอก OTP", true);

    try {
      setFpMsg("กำลังตรวจสอบ OTP...", false);
      const res = await fetch(`${API_BASE}/api/auth/verify-reset-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, otp }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setFpMsg(data.error || "OTP ไม่ถูกต้อง", true);

      resetToken = data.resetToken;
      hide(forgotWrap);
      
      show(resetWrap);
      setResetMsg("OTP ถูกต้อง ✅ ตั้งรหัสผ่านใหม่ได้เลย", false);
      fpNewPassEl.focus();
    } catch (err) {
      console.error(err);
      setFpMsg("Network error / server error", true);
    }
  });
}

// submit new password
if (resetForm) {
  resetForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    setResetMsg("");

    const email = fpEmailEl.value.trim();
    const newPassword = fpNewPassEl.value;
    const confirm = fpConfirmPassEl.value;

    if (!resetToken) return setResetMsg("ไม่มี resetToken (กรุณายืนยัน OTP ใหม่)", true);
    if (newPassword.length < 8) return setResetMsg("รหัสผ่านต้องอย่างน้อย 8 ตัว", true);
    if (newPassword !== confirm) return setResetMsg("รหัสผ่านไม่ตรงกัน", true);

    try {
      setResetMsg("กำลังรีเซ็ตรหัสผ่าน...", false);
      const res = await fetch(`${API_BASE}/api/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, resetToken, newPassword }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setResetMsg(data.error || "รีเซ็ตไม่สำเร็จ", true);

      setResetMsg("รีเซ็ตรหัสผ่านเรียบร้อย ✅ ไปล็อกอินได้เลย", false);

      // auto-close reset UI, back to login
      hide(resetWrap);
    } catch (err) {
      console.error(err);
      setResetMsg("Network error / server error", true);
    }
  });
}

// toggle show/hide for password fields
function bindToggle(toggleId, inputId) {
  const t = document.getElementById(toggleId);
  const inp = document.getElementById(inputId);
  if (!t || !inp) return;

  t.addEventListener("click", () => {
    const isHidden = inp.type === "password";
    inp.type = isHidden ? "text" : "password";
    const icon = t.querySelector("i");
    if (icon) icon.className = isHidden ? "fa fa-eye-slash" : "fa fa-eye";
  });
}
bindToggle("togglePass", "password");
bindToggle("fpToggleNew", "fpNewPassword");
bindToggle("fpToggleConfirm", "fpConfirmPassword");
