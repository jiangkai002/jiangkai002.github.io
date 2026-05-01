async function injectPartial(selector, url, replacements = {}) {
  const host = document.querySelector(selector);
  if (!host) return;

  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) return;

  let html = await res.text();
  for (const [key, value] of Object.entries(replacements)) {
    html = html.replaceAll(key, value);
  }
  host.innerHTML = html;
}

document.addEventListener("DOMContentLoaded", async () => {
  const base = document.body?.dataset?.base ?? "";

  await injectPartial("[data-include='header']", `${base}partials/site-header.html`, {
    "{BASE}": base,
  });

  await injectPartial("[data-include='footer']", `${base}partials/site-footer.html`);
});

