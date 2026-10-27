import { t } from "../i18n/locale";
import { renderKatexMathml, renderMermaidSvg } from "./diagrams";
import { highlightCode } from "./highlight";
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
pre.shiki { border: 1px solid ${palette.border}; border-radius: 6px; padding: 14px 16px; overflow: auto; }
pre.shiki code { background: transparent; }
blockquote { margin: 1em 0; padding: 4px 16px; border-left: 3px solid ${palette.accentDim}; color: ${palette.dim}; }
table { border-collapse: collapse; }
th, td { border: 1px solid ${palette.border}; padding: 6px 10px; }
img { max-width: 100%; }
hr { border: none; border-top: 1px solid ${palette.border}; margin: 1.8em 0; }
.katex { font-family: "Cambria Math", "STIX Two Math", "Times New Roman", serif; }
.katex-display { display: block; margin: 0.9em 0; overflow-x: auto; text-align: center; }
.mermaid-diagram { margin: 0.9em 0; overflow-x: auto; }
.mermaid-diagram svg { max-width: 100%; height: auto; }
.export-render-fallback {
  display: inline-flex;
  gap: 0.45em;
  align-items: baseline;
  margin: 0.25em 0;
  padding: 0.3em 0.5em;
  border: 1px solid ${palette.accentDim};
  border-radius: 4px;
  color: ${palette.dim};
  background: ${palette.codeBg};
  font-size: 0.9em;
}
.export-render-fallback code { padding: 0; background: transparent; }
.export-render-fallback--block { display: flex; margin: 0.9em 0 0.35em; }
.export-image-fallback { font-style: normal; }
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

export interface ExportRenderers {
  highlight(
    source: string,
    language: string | null | undefined,
    theme: ResolvedTheme
  ): Promise<string | null>;
  katex(visible: string, display: boolean): Promise<string | null>;
  mermaid(source: string, theme: ResolvedTheme): Promise<string | null>;
}

const DEFAULT_RENDERERS: ExportRenderers = {
  highlight: highlightCode,
  katex: renderKatexMathml,
  mermaid: renderMermaidSvg,
};

const FENCED_CODE =
  /<pre class="md-code"><code(?: class="language-([^"]+)")?>([\s\S]*?)<\/code><\/pre>\n?/g;
const DISPLAY_MATH = /<span class="math-inline math-display">([\s\S]*?)<\/span>/g;
const BLOCK_MATH = /<div class="math-block">([\s\S]*?)<\/div>\n?/g;
const INLINE_MATH = /<span class="math-inline">([\s\S]*?)<\/span>/g;

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z]+));/gi,
    (entity, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
      const number = hex
        ? Number.parseInt(hex, 16)
        : decimal
          ? Number.parseInt(decimal, 10)
          : undefined;
      if (number !== undefined) {
        try {
          return String.fromCodePoint(number);
        } catch {
          return entity;
        }
      }
      const decoded: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
      };
      return named ? (decoded[named.toLowerCase()] ?? entity) : entity;
    }
  );
}

async function replaceAsync(
  source: string,
  pattern: RegExp,
  replace: (match: RegExpMatchArray) => Promise<string>
): Promise<string> {
  let cursor = 0;
  let result = "";
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    result += source.slice(cursor, index);
    result += await replace(match);
    cursor = index + match[0].length;
  }
  return result + source.slice(cursor);
}

function mathFallback(source: string): string {
  return `<span class="export-render-fallback export-render-fallback--math" role="note">${escapeHtml(
    t("export.mathFallback")
  )}<code>${escapeHtml(source)}</code></span>`;
}

function mermaidFallback(source: string): string {
  return `<div class="export-render-fallback export-render-fallback--block" role="note">${escapeHtml(
    t("export.mermaidFallback")
  )}</div>${source}`;
}

function imageFallback(path: string): string {
  return `<figure class="export-render-fallback export-render-fallback--block export-image-fallback" role="note"><figcaption>${escapeHtml(
    t("export.imageFallback", { path })
  )}</figcaption></figure>`;
}

function imageSource(tag: string): string {
  const source = /\ssrc="([^"]*)"/.exec(tag)?.[1] ?? "";
  return decodeHtmlEntities(source) || t("export.imageUnknown");
}

/**
 * Upgrade the shared Markdown output into portable, finished export content.
 * The preview uses the same Markdown parser and the same Shiki, Mermaid and
 * KaTeX renderers; exports use MathML so a saved file has no font dependency.
 */
export async function renderExportBody(
  markdown: string,
  options: ExportOptions = {},
  renderers: ExportRenderers = DEFAULT_RENDERERS
): Promise<string> {
  const theme = options.theme ?? "dark";
  let body = renderMarkdown(markdown, options.baseDir ? { baseDir: options.baseDir } : {});

  body = await replaceAsync(body, FENCED_CODE, async (match) => {
    const language = match[1]?.toLowerCase();
    const source = decodeHtmlEntities(match[2] ?? "");
    if (language === "mermaid") {
      const svg = await renderers.mermaid(source, theme);
      return svg ? `<div class="mermaid-diagram">${svg}</div>` : mermaidFallback(match[0]);
    }
    return (await renderers.highlight(source, language, theme)) ?? match[0];
  });

  const renderMath = async (match: RegExpMatchArray, display: boolean) => {
    const source = decodeHtmlEntities(match[1] ?? "");
    return (await renderers.katex(source, display)) ?? mathFallback(source);
  };
  body = await replaceAsync(body, DISPLAY_MATH, (match) => renderMath(match, true));
  body = await replaceAsync(body, BLOCK_MATH, (match) => renderMath(match, true));
  return replaceAsync(body, INLINE_MATH, (match) => renderMath(match, false));
}

/** Build a self-contained HTML document from Markdown source. */
export async function buildHtmlDocument(
  title: string,
  markdown: string,
  options: ExportOptions = {}
): Promise<string> {
  const safeTitle = escapeHtml(title.trim() || t("export.untitled"));
  const body = await renderExportBody(markdown, options);
  return `<!doctype html>
<html lang="${t("export.htmlLang")}">
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
    let uri: string | null = null;
    try {
      uri = await load(match[1]);
    } catch {
      // The exported document must explain a missing local asset instead of
      // silently leaving a broken relative image link behind.
    }
    if (!uri) {
      result = result.replace(tag, imageFallback(imageSource(tag)));
      continue;
    }
    const replaced = tag
      .replace(/\sdata-local-path="[^"]*"/, "")
      .replace(/\ssrc="[^"]*"/, "")
      .replace(/^<img/, `<img src="${uri}"`);
    result = result.replace(tag, replaced);
  }
  return result;
}
