const form =document.getElementById("contact-form");
const statusEl = document.getElementById("contact-status");

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
    const res = await fetch("https://localhost:3000/api/contact", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if(!res.ok) throw new Error(data.error || 'Something went wrong!');

    statusEl.textContent = "Message sent successfully!";
    form.reset();
  } catch (error) {
    statusEl.textContent = "Error: " + error.message;
    console.error(error);
  }
});