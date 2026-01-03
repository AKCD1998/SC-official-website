const API_BASE = "https://sc-official-website.onrender.com";

const form = document.getElementById("signupForm");
const otpBox = document.getElementById("otpBox");
const verifyBtn = document.getElementById("verifyBtn");
const msg = document.getElementById("msg");

const fullNameEl = document.getElementById("fullName");
const emailEl = document.getElementById("email");
const passwordEl = document.getElementById("password");
const otpEl = document.getElementById("otp");

let savedEmail = "";

function setMsg(text, isError = false) {
  msg.textContent = text;
  msg.style.color = isError ? "crimson" : "inherit";
}

// Step 1: send OTP (email only)
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  setMsg("");

  const email = emailEl.value.trim();
  const fullName = fullNameEl.value.trim();
  const password = passwordEl.value;

  if (!fullName || !email || !password) return setMsg("Fill all fields first.", true);

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
    otpBox.style.display = "block";
    setMsg("✅ Code sent. Check your email and enter the 6-digit code.");
  } catch (err) {
    setMsg("❌ " + err.message, true);
  }
});

// Step 2: verify OTP, then create account
verifyBtn.addEventListener("click", async () => {
  setMsg("");

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
      body: JSON.stringify({ fullName, email: savedEmail, password }),
    });

    const data2 = await r2.json();
    if (!r2.ok) throw new Error(data2.error || "Finish signup failed");

    setMsg("✅ Account created! You can now log in.");
    // window.location.href = "./login-form.html";
  } catch (err) {
    setMsg("❌ " + err.message, true);
  }
});
