import { renderMarkdown } from "./markdown";
import type { ResolvedTheme } from "./theme";

interface ExportPalette {
  scheme: ResolvedTheme;
  bg: string;
  fg: string;
  dim: string;
  border: string;
  accent: string;
  accentDim: string;
  code: string;
  codeBg: string;
}

const EXPORT_PALETTES: Record<ResolvedTheme, ExportPalette> = {
  dark: {
    scheme: "dark",
    bg: "#16171b",
    fg: "#e6e6e9",
    dim: "#8b8e99",
    border: "#2b2d36",
    accent: "#7aa2f7",
    accentDim: "#3d5f9e",
    code: "#101116",
    codeBg: "rgba(255, 255, 255, 0.06)",
  },
  light: {
    scheme: "light",
    bg: "#f3f4f7",
    fg: "#1c1d21",
    dim: "#5e6270",
    border: "#d4d7e0",
    accent: "#3d6fd8",
    accentDim: "#2f5bb5",
    code: "#ffffff",
    codeBg: "rgba(28, 29, 33, 0.06)",
  },
};

/** Inline stylesheet so the exported file matches the appearance at export time. */
export function exportStyleFor(theme: ResolvedTheme = "dark"): string {
  const palette = EXPORT_PALETTES[theme];
  return `
:root { color-scheme: ${palette.scheme}; }
body {
  max-width: 820px;
  margin: 0 auto;
  padding: 40px 24px 80px;
  background: ${palette.bg};
  color: ${palette.fg};
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif;
  font-size: 15px;
  line-height: 1.8;
}
h1, h2, h3, h4 { line-height: 1.3; margin: 1.5em 0 0.6em; }
h1 { font-size: 1.9em; }
h2 { font-size: 1.5em; border-bottom: 1px solid ${palette.border}; padding-bottom: 4px; }
a { color: ${palette.accent}; }
code { font-family: "Cascadia Code", "JetBrains Mono", Consolas, monospace; font-size: 0.9em; }
:not(pre) > code { background: ${palette.codeBg}; padding: 1px 5px; border-radius: 4px; }
pre.md-code { background: ${palette.code}; border: 1px solid ${palette.border}; border-radius: 6px; padding: 14px 16px; overflow: auto; }
blockquote { margin: 1em 0; padding: 4px 16px; border-left: 3px solid ${palette.accentDim}; color: ${palette.dim}; }
table { border-collapse: collapse; }
th, td { border: 1px solid ${palette.border}; padding: 6px 10px; }
img { max-width: 100%; }
hr { border: none; border-top: 1px solid ${palette.border}; margin: 1.8em 0; }
`;
}

/** Dark stylesheet, kept for callers that don't pass a theme. */
export const EXPORT_STYLE = exportStyleFor("dark");

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

export interface ExportOptions {
  /** Directory of the source document, used to resolve relative image paths. */
  baseDir?: string;
  /** Appearance baked into the exported stylesheet. */
  theme?: ResolvedTheme;
}

/** Build a self-contained HTML document from Markdown source. */
export function buildHtmlDocument(
  title: string,
  markdown: string,
  options: ExportOptions = {}
): string {
  const safeTitle = escapeHtml(title.trim() || "未命名文档");
  const body = renderMarkdown(markdown, options.baseDir ? { baseDir: options.baseDir } : {});
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>${exportStyleFor(options.theme ?? "dark")}</style>
</head>
<body>
<main class="markdown-body">
${body}
</main>
</body>
</html>
`;
}

/**
 * Replace locally-resolved `<img>` tags (`data-local-path` from the Markdown
 * renderer) with inline data URIs so the exported file is portable.
 */
export async function inlineLocalImages(
  html: string,
  load: (path: string) => Promise<string | null>
): Promise<string> {
  const tags = Array.from(html.matchAll(/<img[^>]*data-local-path="([^"]+)"[^>]*>/g));
  let result = html;
  for (const match of tags) {
    const tag = match[0];
    const uri = await load(match[1]);
    if (!uri) continue;
    const replaced = tag
      .replace(/\sdata-local-path="[^"]*"/, "")
      .replace(/\ssrc="[^"]*"/, "")
      .replace(/^<img/, `<img src="${uri}"`);
    result = result.replace(tag, replaced);
  }
  return result;
}
