document.addEventListener("DOMContentLoaded", () => {

  // ── 年份自动填充 ──────────────────────────────────────────
  const yearNode = document.getElementById("current-year");
  if (yearNode) {
    yearNode.textContent = String(new Date().getFullYear());
  }

  // ── 自定义光标 ─────────────────────────────────────────────
  const cursor    = document.getElementById("cursor");
  const cursorDot = document.getElementById("cursor-dot");

  if (cursor && cursorDot && window.matchMedia("(pointer: fine)").matches) {
    let mouseX = 0, mouseY = 0;
    let curX = 0, curY = 0;

    document.addEventListener("mousemove", (e) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
      cursorDot.style.left = mouseX + "px";
      cursorDot.style.top  = mouseY + "px";
      cursor.classList.add("visible");
      cursorDot.classList.add("visible");
    });

    const animateCursor = () => {
      curX += (mouseX - curX) * 0.11;
      curY += (mouseY - curY) * 0.11;
      cursor.style.left = curX + "px";
      cursor.style.top  = curY + "px";
      requestAnimationFrame(animateCursor);
    };
    animateCursor();

    document.querySelectorAll("a, button").forEach((el) => {
      el.addEventListener("mouseenter", () => cursor.classList.add("hovered"));
      el.addEventListener("mouseleave", () => cursor.classList.remove("hovered"));
    });

    document.addEventListener("mouseleave", () => {
      cursor.classList.remove("visible");
      cursorDot.classList.remove("visible");
    });
  }

  // ── 移动端菜单 ────────────────────────────────────────────
  const navToggle = document.querySelector(".nav-toggle");
  const siteNav   = document.querySelector(".site-nav");

  if (navToggle && siteNav) {
    navToggle.addEventListener("click", () => {
      const isOpen = siteNav.classList.toggle("open");
      navToggle.setAttribute("aria-expanded", String(isOpen));
    });

    siteNav.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        siteNav.classList.remove("open");
        navToggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  // ── Header 滚动状态 ───────────────────────────────────────
  const header = document.querySelector(".site-header");
  if (header) {
    const onScroll = () => {
      header.classList.toggle("scrolled", window.scrollY > 10);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // ── 导航高亮（IntersectionObserver）─────────────────────
  const sections = document.querySelectorAll("main section[id]");
  const navLinks  = document.querySelectorAll(".site-nav a[href^='#']");

  if (sections.length && navLinks.length) {
    const sectionObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const activeId = entry.target.id;
            navLinks.forEach((link) => {
              link.classList.toggle(
                "active",
                link.getAttribute("href") === `#${activeId}`
              );
            });
          }
        });
      },
      { rootMargin: "-30% 0px -60% 0px", threshold: 0 }
    );

    sections.forEach((sec) => sectionObserver.observe(sec));
  }

  // ── 入场动画（Reveal on scroll）─────────────────────────
  const revealEls = document.querySelectorAll(".reveal");

  if (revealEls.length) {
    const revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
            revealObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.08, rootMargin: "0px 0px -50px 0px" }
    );

    revealEls.forEach((el, i) => {
      el.style.transitionDelay = `${(i % 5) * 0.07}s`;
      revealObserver.observe(el);
    });
  }

});
