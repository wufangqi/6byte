/**
 * Lazy KaTeX and Mermaid for the Markdown preview (M2, T32/T33).
 *
 * The markdown renderer only emits placeholders. These loaders run after paint,
 * so the editor bundle stays free of both libraries. A failure returns null and
 * the caller keeps the original text or code block.
 */

import type { ResolvedTheme } from "./theme";

const UNSAFE_SVG = /<script[\s>/]|javascript:|\son[a-z]+\s*=/i;

let katexPromise: Promise<typeof import("katex").default | null> | null = null;
let mermaidPromise: Promise<typeof import("mermaid").default | null> | null = null;
let mermaidSeq = 0;

function loadKatex(): Promise<typeof import("katex").default | null> {
  katexPromise ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")])
    .then(([mod]) => mod.default)
    .catch(() => null);
  return katexPromise;
}

function loadMermaid(): Promise<typeof import("mermaid").default | null> {
  mermaidPromise ??= import("mermaid")
    .then((mod) => {
      const mermaid = mod.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "dark",
        suppressErrorRendering: true,
        fontFamily: "inherit",
      });
      return mermaid;
    })
    .catch(() => null);
  return mermaidPromise;
}

/** Pull the TeX source out of a `$…$` or `$$…$$` placeholder. */
export function texSource(visible: string, display: boolean): string {
  const text = visible.trim();
  if (display && text.startsWith("$$") && text.endsWith("$$")) return text.slice(2, -2).trim();
  if (!display && text.startsWith("$") && text.endsWith("$")) return text.slice(1, -1).trim();
  return text;
}

/** KaTeX HTML, or null when the formula cannot be parsed. */
export async function renderKatexHtml(visible: string, display: boolean): Promise<string | null> {
  const tex = texSource(visible, display);
  if (!tex) return null;
  const katex = await loadKatex();
  if (!katex) return null;
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: true,
      trust: false,
    });
  } catch {
    return null;
  }
}

/** Mermaid SVG, or null when the diagram cannot be parsed. */
export async function renderMermaidSvg(
  source: string,
  theme: ResolvedTheme = "dark"
): Promise<string | null> {
  const text = source.trim();
  if (!text) return null;
  const mermaid = await loadMermaid();
  if (!mermaid) return null;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: theme === "light" ? "default" : "dark",
    suppressErrorRendering: true,
    fontFamily: "inherit",
  });
  const id = `mmd${mermaidSeq++}`;
  try {
    const { svg } = await mermaid.render(id, text);
    if (!svg || UNSAFE_SVG.test(svg)) return null;
    return svg;
  } catch {
    if (typeof document !== "undefined") document.getElementById(id)?.remove();
    return null;
  }
}
