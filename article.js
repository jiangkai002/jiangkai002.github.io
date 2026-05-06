/**
 * article.js — 通用文章加载器
 *
 * 使用方式：在文章 HTML 里引入此脚本，它会自动读取同目录下
 * 与 HTML 文件同名的 .md 文件并渲染到页面中。
 *
 * MD 文件头部 front matter 格式（可选）：
 * ---
 * title: 文章标题
 * date: 2026-05-01
 * tags: [标签1, 标签2]
 * description: 一句话简介
 * read-time: 约 12 分钟
 * ---
 */

(async () => {
  // 从当前页面 URL 推导 .md 文件路径
  const mdPath = location.pathname.replace(/\.html$/, '.md');

  marked.use({ gfm: true, breaks: false });

  // ── 解析 front matter ──────────────────────────────────
  function parseFrontMatter(raw) {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) return { meta: {}, body: raw };

    const meta = {};
    match[1].split('\n').forEach((line) => {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) return;
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      if (!key) return;

      if (val.startsWith('[') && val.endsWith(']')) {
        meta[key] = val.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
      } else {
        meta[key] = val;
      }
    });

    return { meta, body: match[2] };
  }

  // ── 渲染 meta 区域 ─────────────────────────────────────
  function renderMeta(meta) {
    const metaEl = document.getElementById('article-meta');
    if (!metaEl) return;

    const tags = Array.isArray(meta.tags)
      ? meta.tags
      : meta.tags
      ? [meta.tags]
      : [];

    metaEl.innerHTML = [
      ...tags.map((t) => `<span class="tag">${t}</span>`),
      meta.date   ? `<time>${meta.date}</time>` : '',
      meta['read-time'] ? `<span class="read-time">${meta['read-time']}</span>` : '',
    ].join('');
  }

  // ── 主流程 ─────────────────────────────────────────────
  try {
    const res = await fetch(mdPath);
    if (!res.ok) throw new Error(`HTTP ${res.status} — 找不到 ${mdPath}`);

    const raw = await res.text();
    const { meta, body } = parseFrontMatter(raw);

    const title = meta.title || document.title;
    document.title = `${title} · JK`;

    const titleEl = document.getElementById('article-title');
    if (titleEl) titleEl.textContent = title;

    const descEl = document.getElementById('article-desc');
    if (descEl && meta.description) descEl.textContent = meta.description;

    renderMeta(meta);

    const bodyEl = document.getElementById('article-body');
    if (bodyEl) bodyEl.innerHTML = marked.parse(body);

  } catch (err) {
    const bodyEl = document.getElementById('article-body');
    if (bodyEl) {
      bodyEl.innerHTML = `
        <p style="color:var(--red);font-family:var(--font-mono);font-size:0.85rem">
          ⚠ 加载失败：${err.message}
        </p>`;
    }
  }
})();
