# jiangkai002.github.io

江凯（JK）的个人网站，基于纯前端方案实现「写 Markdown 自动渲染为网页」，无需构建工具。

---

## 核心渲染流程

```
.md 文件
  ↓  fetch()
article.js
  ↓  parseFrontMatter()
  ↓  marked.parse()  ← GFM + 数学公式 + 代码高亮
article-body DOM
```

每篇文章只需要两个文件：

- **`.html`** — 固定模板，负责引入脚本和预置样式
- **`.md`** — 用 Markdown 写正文，开头可选地放 front matter 元数据

运行时 `article.js` 会根据当前 URL 自动找到同路径的 `.md` 文件，把 front matter 填充到页面 meta 区，把 Markdown 正文渲染进 `#article-body`。

---

## front matter 格式

写在 `.md` 文件顶部，用 `---` 分隔：

```yaml
---
title: 文章标题
date: 2026-05-01
tags: [Docker, 工程化]
description: 一句话简介
read-time: 约 6 分钟
---
```

`article.js` 会解析这些字段并渲染到文章页的 meta 区域。如果不写 front matter，页面仍能正常加载，只是标题和描述使用 HTML 中预置的默认值。

---

## 支持的功能

| 功能 | 实现方式 |
|------|----------|
| Markdown 渲染 | `marked`（GFM 模式） |
| 数学公式 | MathJax 3，`$inline$` / `$$display$$` |
| 代码高亮 | Prism.js，支持 json / csharp / python / typescript 等 |
| front matter | article.js 手写解析，无第三方依赖 |
| 文章模板复用 | `articles/_template.html` 复制后改名为 `.html` 即可 |

---

## 新增文章的步骤

1. 复制 `articles/_template.html`，重命名为目标 `.html`，如 `articles/docker-dev/docker-dev.html`
2. 在同目录创建同名 `.md` 文件，如 `articles/docker-dev/docker-dev.md`
3. 在 `.md` 顶部加上 front matter
4. 在主页 `index.html` 的 articles 区块加一条卡片链接

每篇文章的 `.html` 是完全静态的模板，内容全部在 `.md` 里。

---

## 目录结构

```
jiangkai002.github.io/
├── index.html                # 主页
├── main.css                  # 全局样式（包含文章正文排版）
├── article.js                # 文章加载器（自动渲染 .md）
├── includes.js               # partial 注入（header / footer）
├── partials/
│   ├── site-header.html      # 导航栏模板
│   └── site-footer.html      # 页脚模板
└── articles/
    └── _template.html        # 新建文章时复制此文件
```

项目页（如 `projects/pipelineFlow/pipelineFlow.html`）也复用同一套模板和脚本，只是入口是 `projects/` 路径下。

---

## 部署

纯静态站点，直接 push 到 GitHub Pages 即可。

---

## 技术栈

- **Markdown 渲染** — [marked](https://marked.js.org/)
- **数学公式** — [MathJax 3](https://www.mathjax.org/)
- **代码高亮** — [Prism.js](https://prismjs.com/)
- **样式** — 纯手写 CSS，自适应字体（PingFang SC / IBM Plex Mono / Bebas Neue）
