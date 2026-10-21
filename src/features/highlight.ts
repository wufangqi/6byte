/**
 * Lazy Shiki highlighter for fenced code blocks in the Markdown preview (M2).
 *
 * Only the ten languages we actually support plus one theme are bundled, and the
 * whole thing is a dynamic import: the editor's initial bundle stays small and
 * the first preview with a code fence pays a one-off cost. If the highlighter
 * cannot load, the caller keeps markdown-it's plain escaped `<pre>`.
 */
import type { HighlighterCore, LanguageRegistration, ThemeRegistrationAny } from "shiki/core";

const LANGUAGES = [
  "javascript",
  "typescript",
  "json",
  "html",
  "css",
  "rust",
  "python",
  "bash",
  "markdown",
  "yaml",
] as const;

const ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  sh: "bash",
  shell: "bash",
  console: "bash",
  yml: "yaml",
  rs: "rust",
  md: "markdown",
};

export const SHIKI_THEME = "github-dark";

type LanguageModule = { default: LanguageRegistration[] };
type ThemeModule = { default: ThemeRegistrationAny };

const languageModules: Promise<LanguageModule>[] = [
  import("shiki/langs/javascript.mjs"),
  import("shiki/langs/typescript.mjs"),
  import("shiki/langs/json.mjs"),
  import("shiki/langs/html.mjs"),
  import("shiki/langs/css.mjs"),
  import("shiki/langs/rust.mjs"),
  import("shiki/langs/python.mjs"),
  import("shiki/langs/bash.mjs"),
  import("shiki/langs/markdown.mjs"),
  import("shiki/langs/yaml.mjs"),
];

let highlighterPromise: Promise<HighlighterCore | null> | null = null;

const loadHighlighter = (): Promise<HighlighterCore | null> => {
  highlighterPromise ??= (async () => {
    const [{ createHighlighterCore }, { createOnigurumaEngine }, theme, ...languageSets] =
      await Promise.all([
        import("shiki/core"),
        import("shiki/engine/oniguruma"),
        import("shiki/themes/github-dark.mjs") as Promise<ThemeModule>,
        ...languageModules,
      ]);

    return createHighlighterCore({
      themes: [theme.default],
      langs: languageSets.flatMap((module) => (module as LanguageModule).default),
      engine: createOnigurumaEngine(import("shiki/wasm")),
    });
  })().catch(() => null);
  return highlighterPromise;
};

/** Map a fence language (or alias) to a bundled Shiki language, if supported. */
export function normalizeLanguage(language: string | null | undefined): string | null {
  const value = (language ?? "").trim().toLowerCase();
  if (!value) return null;
  const normalized = ALIASES[value] ?? value;
  return (LANGUAGES as readonly string[]).includes(normalized) ? normalized : null;
}

/**
 * Highlight `code` and return Shiki's `<pre class="shiki">` HTML, or `null` when
 * the language is unsupported / the highlighter failed to load.
 */
export async function highlightCode(
  code: string,
  language: string | null | undefined
): Promise<string | null> {
  const normalized = normalizeLanguage(language);
  if (!normalized || !code.trim()) return null;
  const highlighter = await loadHighlighter();
  if (!highlighter) return null;
  try {
    return highlighter.codeToHtml(code.replace(/\n$/, ""), {
      lang: normalized,
      theme: SHIKI_THEME,
    });
  } catch {
    return null;
  }
}
