  
  // ==================================== //
  // ========== Map Branch Search ========== //
  // ==================================== //
  
  document.addEventListener("DOMContentLoaded", () => {
    const mapInput = document.getElementById("branchSearch");
    const mapList = document.getElementById("branchList");
    if (!mapInput || !mapList) return;

    const mapCards = Array.from(mapList.querySelectorAll(".branch-card"));

    mapInput.addEventListener("input", () => {
      const query = mapInput.value.trim().toLowerCase();
      
      mapCards.forEach((card) => {
        const mapText = card.textContent.trim().toLowerCase();
        card.style.display = mapText.includes(query) ? "" : "none";
      });  
    });
  });  
  



// =============================================== //
// ========== Map Branch Search + Click ========== //
// =============================================== //

document.addEventListener("DOMContentLoaded", () => {
  const mapInput = document.getElementById("branchSearch");
  const mapList  = document.getElementById("branchList");
  const mapEl    = document.getElementById("branchMap");

  if (!mapList || !mapEl) {
    console.error("Missing #branchList or #branchMap");
    return;
  }

  const cards = Array.from(mapList.querySelectorAll(".branch-card"));

  function setMap(lat, lng) {
    mapEl.src = `https://www.google.com/maps?q=${lat},${lng}&z=16&output=embed`;
  }

  // ---- Click card -> move map ----
  cards.forEach(card => {
    card.addEventListener("click", (e) => {
      // กดปุ่ม/ลิงก์ "เส้นทาง" ให้เปิดแท็บตามเดิม
      if (e.target.closest("a")) return;

      const { lat, lng } = card.dataset;
      if (!lat || !lng) return;

      setMap(lat, lng);

      cards.forEach(c => c.classList.remove("is-active"));
      card.classList.add("is-active");
    });
  });

  // ---- Search filter ----
  if (mapInput) {
    mapInput.addEventListener("input", () => {
      const query = mapInput.value.trim().toLowerCase();

      cards.forEach(card => {
        const text = card.textContent.toLowerCase();
        card.style.display = text.includes(query) ? "" : "none";
      });
    });
  }

  // ---- Optional: ตั้งค่าเริ่มต้นเป็นการ์ดแรก ----
  const first = cards.find(c => c.dataset.lat && c.dataset.lng);
  if (first) {
    setMap(first.dataset.lat, first.dataset.lng);
    first.classList.add("is-active");
  }
});
