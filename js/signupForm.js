  // ✅ CHANGE THIS:
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
  let signupDone = false;

  function setMsg(text, isError=false){
    msg.textContent = text;
    msg.style.color = isError ? "crimson" : "inherit";
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setMsg("");

    const fullName = fullNameEl.value.trim();
    const email = emailEl.value.trim();
    const password = passwordEl.value;

    try {
      setMsg("Creating account & sending verification code...");

      const r = await fetch(`${API_BASE}/api/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName, email, password })
      });

      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Signup failed");

      signupDone = true;
      savedEmail = email;

      otpBox.style.display = "block";
      setMsg("✅ Code sent. Please check your email and enter the 6-digit code.");
    } catch (err) {
      setMsg("❌ " + err.message, true);
    }
  });

  verifyBtn.addEventListener("click", async () => {
    setMsg("");

    if (!signupDone) return setMsg("Please sign up first.", true);

    const code = otpEl.value.trim();

    try {
      setMsg("Verifying code...");

      const r = await fetch(`${API_BASE}/api/auth/verify-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: savedEmail, code })
      });

      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Verification failed");

      setMsg("✅ Email verified! You can now log in.");

      // Optional: redirect to login page
      // window.location.href = "./login-form.html";
    } catch (err) {
      setMsg("❌ " + err.message, true);
    }
  });

