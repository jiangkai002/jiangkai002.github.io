document.addEventListener("DOMContentLoaded", () => {
  const yearNode = document.getElementById("current-year");
  if (yearNode) {
    yearNode.textContent = String(new Date().getFullYear());
  }

  const navLinks = document.querySelectorAll('.site-nav a[href^="#"]');
  navLinks.forEach((link) => {
    link.addEventListener("click", (event) => {
      const targetId = link.getAttribute("href");
      if (!targetId) return;
      const targetNode = document.querySelector(targetId);
      if (!targetNode) return;

      event.preventDefault();
      targetNode.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
});
