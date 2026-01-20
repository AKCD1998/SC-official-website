const form = document.getElementById("contact-form");
const statusEl = document.getElementById("contact-status");

const ENDPOINT = "/api/contact";

form.addEventListener("submit", async function (e) {
  e.preventDefault();

  const formData = new FormData(form);
  const payload = {
    name: formData.get("name"),
    email: formData.get("email"),
    message: formData.get("message"),
  };

  statusEl.textContent = "Sending...";

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Something went wrong!");

    statusEl.textContent = "Message sent successfully!";
    form.reset();
  } catch (error) {
    statusEl.textContent = "Error: " + error.message;
    console.error(error);
  }
});
