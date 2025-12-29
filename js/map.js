console.log("✅ map.js loaded");

document.addEventListener("DOMContentLoaded", () => {
  const mapInput = document.getElementById("branchSearch");
  const mapList  = document.getElementById("branchList");
  const mapEl    = document.getElementById("branchMap");

  console.log("mapInput:", !!mapInput, "mapList:", !!mapList, "mapEl:", !!mapEl);

  if (!mapList || !mapEl) return;

  const cards = Array.from(mapList.querySelectorAll(".branch-card"));
  console.log("cards:", cards.length);

  function setMap(lat, lng) {
    mapEl.src = `https://www.google.com/maps?q=${lat},${lng}&z=16&output=embed`;
  }

  cards.forEach(card => {
    card.addEventListener("click", (e) => {
      console.log("clicked:", card.dataset.lat, card.dataset.lng);

      if (e.target.closest("a")) return;

      const { lat, lng } = card.dataset;
      if (!lat || !lng) return;

      setMap(lat, lng);
      cards.forEach(c => c.classList.remove("is-active"));
      card.classList.add("is-active");
    });
  });

  if (mapInput) {
    mapInput.addEventListener("input", () => {
      const query = mapInput.value.trim().toLowerCase();
      cards.forEach(card => {
        const text = card.textContent.toLowerCase();
        card.style.display = text.includes(query) ? "" : "none";
      });
    });
  }

  const first = cards.find(c => c.dataset.lat && c.dataset.lng);
  if (first) setMap(first.dataset.lat, first.dataset.lng);
});
