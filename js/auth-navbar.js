// js/auth-navbar.js
  function parseJwt(token) {
    try {
      const payload = token.split(".")[1];
      const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  function getRepoBase() {
    const repo = location.pathname.split("/")[1]; // SC-official-website
    return `${location.origin}/${repo}`;
  }

  document.addEventListener("DOMContentLoaded", () => {
    const token = localStorage.getItem("token");

    const authLink = document.getElementById("authLink");
    const authText = document.getElementById("authText");
    const authMenu = document.getElementById("authMenu");
    const authCaret = document.getElementById("authCaret");

    const menuEditProfile = document.getElementById("menuEditProfile");
    const menuLinkAccount = document.getElementById("menuLinkAccount");
    const menuLogout = document.getElementById("menuLogout");

    function showMenu() { if (authMenu) authMenu.style.display = "block"; }
    function hideMenu() { if (authMenu) authMenu.style.display = "none"; }
    function toggleMenu() {
      if (!authMenu) return;
      authMenu.style.display = (authMenu.style.display === "none" || !authMenu.style.display) ? "block" : "none";
    }

    // If logged in -> change text to email and enable dropdown
    if (token) {
      const payload = parseJwt(token);
      const email = payload?.email || "Account";

      if (authText) authText.textContent = email;
      if (authCaret) authCaret.style.display = "inline-block";

      // clicking the user/email should open menu, not go to login page
      if (authLink) {
        authLink.addEventListener("click", (e) => {
          e.preventDefault();
          toggleMenu();
        });
      }
    } else {
      // not logged in -> normal link to login page (no menu)
      if (authText) authText.textContent = "Log in / sign up";
      if (authCaret) authCaret.style.display = "none";
      hideMenu();
    }

    // Coming soon actions
    if (menuEditProfile) menuEditProfile.addEventListener("click", (e) => {
      e.preventDefault();
      alert("Coming soon 🙂");
      hideMenu();
    });

    if (menuLinkAccount) menuLinkAccount.addEventListener("click", (e) => {
      e.preventDefault();
      alert("Coming soon 🙂");
      hideMenu();
    });

    // Logout
    if (menuLogout) menuLogout.addEventListener("click", (e) => {
      e.preventDefault();
      localStorage.removeItem("token");
      hideMenu();

      // send the user back to the site root and force a fresh load
      const target = new URL("./", window.location.href);
      target.hash = "top";
      target.searchParams.set("_logout", Date.now()); // cache-bust to guarantee reload
      window.location.replace(target.toString());
    });

    // Click outside -> close menu
    document.addEventListener("click", (e) => {
      if (!authMenu || authMenu.style.display !== "block") return;
      const navAuth = document.getElementById("navAuth");
      if (navAuth && !navAuth.contains(e.target)) hideMenu();
    });

    // ESC -> close menu
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideMenu();
    });
  });
