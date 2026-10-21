import { renderMarkdown } from "./markdown";

/** Inline stylesheet so the exported file is a single self-contained document. */
export const EXPORT_STYLE = `
:root { color-scheme: dark; }
body {
  max-width: 820px;
  margin: 0 auto;
  padding: 40px 24px 80px;
  background: #16171b;
  color: #e6e6e9;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif;
  font-size: 15px;
  line-height: 1.8;
}
h1, h2, h3, h4 { line-height: 1.3; margin: 1.5em 0 0.6em; }
h1 { font-size: 1.9em; }
h2 { font-size: 1.5em; border-bottom: 1px solid #2b2d36; padding-bottom: 4px; }
a { color: #7aa2f7; }
code { font-family: "Cascadia Code", "JetBrains Mono", Consolas, monospace; font-size: 0.9em; }
:not(pre) > code { background: rgba(255, 255, 255, 0.06); padding: 1px 5px; border-radius: 4px; }
pre.md-code { background: #101116; border: 1px solid #2b2d36; border-radius: 6px; padding: 14px 16px; overflow: auto; }
blockquote { margin: 1em 0; padding: 4px 16px; border-left: 3px solid #3d5f9e; color: #8b8e99; }
table { border-collapse: collapse; }
th, td { border: 1px solid #2b2d36; padding: 6px 10px; }
img { max-width: 100%; }
hr { border: none; border-top: 1px solid #2b2d36; margin: 1.8em 0; }
`;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `notes.md` → `notes.html`; other extensions simply get `.html` appended. */
export function htmlPathFor(markdownPath: string): string {
  return `${markdownPath.replace(/\.(md|markdown|mdx)$/i, "")}.html`;
}

/** Build a self-contained HTML document from Markdown source. */
export function buildHtmlDocument(title: string, markdown: string): string {
  const safeTitle = escapeHtml(title.trim() || "未命名文档");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>${EXPORT_STYLE}</style>
</head>
<body>
<main class="markdown-body">
${renderMarkdown(markdown)}
</main>
</body>
</html>
`;
}
