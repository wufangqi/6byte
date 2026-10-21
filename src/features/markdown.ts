import MarkdownIt from "markdown-it";

/**
 * Markdown renderer for the split preview (M2, T19).
 *
 * `html: false` keeps raw HTML out of the preview, so rendering untrusted
 * documents cannot inject markup or event handlers. Headings get stable slugs so
 * the outline panel can jump to them; fenced code blocks get a `language-*`
 * class for styling and future shiki integration.
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
});

export interface SlugTracker {
  counts: Map<string, number>;
}

export const createSlugTracker = (): SlugTracker => ({ counts: new Map() });

/** GitHub-ish slug, shared by the renderer and the outline parser. */
export function slugify(text: string): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base || "section";
}

/** Deduplicating slug: `intro`, `intro-1`, `intro-2`, … */
export function slugFor(rawText: string, tracker: SlugTracker): string {
  const base = slugify(rawText);
  const seen = tracker.counts.get(base) ?? 0;
  tracker.counts.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen}`;
}

/** Strip the most common inline markdown so outline labels read cleanly. */
export function plainHeadingText(text: string): string {
  return text
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim();
}

interface RenderEnv extends Record<string, unknown> {
  tracker: SlugTracker;
  baseDir?: string;
}

export interface RenderOptions {
  /** Directory of the document, used to resolve relative image paths. */
  baseDir?: string;
}

md.renderer.rules.heading_open = (tokens, index, options, env, self) => {
  const inline = tokens[index + 1];
  const environment = env as unknown as RenderEnv | undefined;
  if (inline && environment?.tracker) {
    tokens[index].attrSet("id", slugFor(inline.content, environment.tracker));
  }
  return self.renderToken(tokens, index, options);
};

const defaultImageRule = md.renderer.rules.image;

/**
 * Relative image paths (e.g. `assets/shot.png` written by the paste handler) get
 * a `data-local-path` attribute with the absolute path; the preview swaps it for
 * an asset-protocol URL because the webview cannot load `file://` paths.
 */
md.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index];
  const rawSource = token.attrGet("src");
  const source = typeof rawSource === "string" ? rawSource : "";
  const environment = env as unknown as RenderEnv | undefined;
  if (source && environment?.baseDir && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(source)) {
    const base = environment.baseDir.replace(/[\\/]+$/, "");
    const separator = base.includes("\\") ? "\\" : "/";
    token.attrSet("data-local-path", `${base}${separator}${source.replace(/\//g, separator)}`);
  }
  return defaultImageRule
    ? defaultImageRule(tokens, index, options, env, self)
    : self.renderToken(tokens, index, options);
};

md.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  const info = token.info.trim().split(/\s+/)[0] ?? "";
  const language = info.replace(/[^\w-]/g, "");
  const code = md.utils.escapeHtml(token.content);
  return `<pre class="md-code"><code${language ? ` class="language-${language}"` : ""}>${code}</code></pre>\n`;
};

export function renderMarkdown(source: string, options: RenderOptions = {}): string {
  const env: RenderEnv = { tracker: createSlugTracker(), baseDir: options.baseDir };
  return md.render(source, env as unknown as Record<string, unknown>);
}

/** True when the file should show the preview toggle by default. */
export function isMarkdownFile(filename: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(filename);
}
