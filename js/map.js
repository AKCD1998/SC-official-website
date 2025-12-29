document.addEventListener(DOMContentLoaded, () => {
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