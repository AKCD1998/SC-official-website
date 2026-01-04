const API_BASE = "https://sc-official-website.onrender.com";

const form = document.getElementById("loginForm");
const emailEl = document.getElementById("email");
const passEl = document.getElementById("password");
const msgEl = document.getElementById("msg");
const signUp = document.getElementById("goSignup");

function setMsg(text, isError = true) {
  msgEl.textContent = text;
  msgEl.style.color = isError ? "crimson" : "green";
}

signUp.addEventListener("click", (e) => {
  e.preventDefault();
  const repo = location.pathname.split("/")[1];
  const base = `${location.origin}/${repo}`;
  window.location.href = `${base}/html/sign-up-form.html`;
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  setMsg("");

  const email = emailEl.value.trim();
  const password = passEl.value;

  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      setMsg(data.error || "Login failed");
      return;
    }

    // เก็บ JWT token
    localStorage.setItem("token", data.token);
    setMsg("Login success ✅", false);

    // ไปหน้า index หรือหน้า dashboard ที่คุณอยากให้เข้า
    
    // ✅ redirect กลับ root ของ repo บน GitHub Pages
  const repo = location.pathname.split("/")[1]; // SC-official-website
  window.location.href = `${location.origin}/${repo}/#`;

  } catch (err) {
    setMsg("Network error / server error");
    console.error(err);
  }
});
