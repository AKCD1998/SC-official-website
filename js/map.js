  
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
  

  // ==================================== //
  // ========== Map Branch Click ========== //
  // ==================================== //
  
  const mapEl = document.getElementById('branchMap');
  const cards = document.querySelectorAll('#branchList .branch-card');

  function setMap(lat, lng) {
    mapEl.src = `https://www.google.com/maps?q=${lat},${lng}&z=16&output=embed`;
  }

  cards.forEach(card => {
    card.addEventListener('click', (e) => {
      // ถ้าคลิกที่ปุ่ม/ลิงก์ ไม่ต้องเปลี่ยนแผนที่ (ให้มันเปิดแท็บตามปกติ)
      if (e.target.closest('a')) return;

      const lat = card.dataset.lat;
      const lng = card.dataset.lng;
      if (!lat || !lng) return;

      setMap(lat, lng);

      cards.forEach(c => c.classList.remove('is-active'));
      card.classList.add('is-active');
    });
  });

