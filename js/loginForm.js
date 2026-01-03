const API_BASE = "https://sc-official-website.onrender.com";

const form = document.getElementById("loginForm");
const emailEl = document.getElementById("email");
const passEl = document.getElementById("password");
const msgEl = document.getElementById("msg");

function setMsg(text, isError = true) {
  msgEl.textContent = text;
  msgEl.style.color = isError ? "crimson" : "green";
}

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

    window.location.href = "https://akcd1998.github.io/SC-official-website/#";


  } catch (err) {
    setMsg("Network error / server error");
    console.error(err);
  }
});
