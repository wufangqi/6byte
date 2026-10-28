import MarkdownIt, { type StateInline, type Token } from "markdown-it";

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
  sourceLines?: boolean;
}

export interface RenderOptions {
  /** Directory of the document, used to resolve relative image paths. */
  baseDir?: string;
  /**
   * Tag block elements with `data-src="start:end"` (0-based lines, end exclusive)
   * so the preview can map a selection back to the source. Off for export.
   */
  sourceLines?: boolean;
}

md.core.ruler.push("source_lines", (state) => {
  if (!(state.env as Partial<RenderEnv> | undefined)?.sourceLines) return;
  for (const token of state.tokens) {
    if (token.nesting === 1 && token.map) {
      token.attrSet("data-src", `${token.map[0]}:${token.map[1]}`);
    }
  }
});

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
 * CommonMark stops an image destination at the first space, so
 * `![图](团建/方案 V-3.png)` never becomes an image. Read through the closing
 * parenthesis when the destination itself contains whitespace.
 */
function readSpacedDestination(
  src: string,
  start: number,
  max: number
): { body: string; end: number } | null {
  let pos = start;
  while (pos < max && (src.charCodeAt(pos) === 32 || src.charCodeAt(pos) === 9)) pos++;
  if (pos >= max || src.charCodeAt(pos) === 60) return null;

  const bodyStart = pos;
  let level = 0;
  while (pos < max) {
    const code = src.charCodeAt(pos);
    if (code === 10 || code === 13) return null;
    if (code === 92 && pos + 1 < max) {
      pos += 2;
      continue;
    }
    if (code === 40) {
      level += 1;
      if (level > 32) return null;
    } else if (code === 41) {
      if (level === 0) break;
      level -= 1;
    }
    pos += 1;
  }
  if (level !== 0 || pos >= max || src.charCodeAt(pos) !== 41) return null;
  const body = src.slice(bodyStart, pos);
  if (!body.includes(" ") && !body.includes("\t")) return null;
  return { body, end: pos };
}

function splitImageTitle(body: string): { href: string; title: string } {
  const match = /^(.*\S)[ \t]+(?:"([^"]*)"|'([^']*)')[ \t]*$/.exec(body);
  if (!match) return { href: body.trim(), title: "" };
  return { href: match[1].trim(), title: match[2] ?? match[3] ?? "" };
}

function imageWithSpaces(state: StateInline, silent: boolean): boolean {
  const max = state.posMax;
  if (state.src.charCodeAt(state.pos) !== 33 || state.src.charCodeAt(state.pos + 1) !== 91) {
    return false;
  }
  const labelStart = state.pos + 2;
  const labelEnd = state.md.helpers.parseLinkLabel(state, state.pos + 1, false);
  if (labelEnd < 0) return false;
  if (labelEnd + 1 >= max || state.src.charCodeAt(labelEnd + 1) !== 40) return false;

  const parsed = readSpacedDestination(state.src, labelEnd + 2, max);
  if (!parsed) return false;
  const split = splitImageTitle(state.md.utils.unescapeAll(parsed.body));
  if (!split.href.includes(" ") && !split.href.includes("\t")) return false;

  const href = state.md.normalizeLink(split.href);
  if (!state.md.validateLink(href)) return false;
  if (!silent) {
    const content = state.src.slice(labelStart, labelEnd);
    const children: Token[] = [];
    state.md.inline.parse(content, state.md, state.env, children);
    const token = state.push("image", "img", 0);
    token.attrs = [
      ["src", href],
      ["alt", ""],
    ];
    token.children = children;
    token.content = content;
    if (split.title) token.attrs.push(["title", split.title]);
  }
  state.pos = parsed.end + 1;
  return true;
}

md.inline.ruler.before("image", "image_spaces", imageWithSpaces);

/**
 * markdown-it percent-encodes destinations, so a Chinese path arrives as
 * `%E5%9B%A2…`. The file system needs the original characters.
 */
function decodeImageSource(source: string): string {
  try {
    return decodeURI(source);
  } catch {
    return source;
  }
}

/**
 * Relative image paths (e.g. `assets/shot.png` written by the paste handler) get
 * a `data-local-path` attribute with the absolute path; the preview swaps it for
 * a data URI because the webview cannot load `file://` paths.
 */
md.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index];
  const rawSource = token.attrGet("src");
  const source = typeof rawSource === "string" ? decodeImageSource(rawSource) : "";
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
  const language = info.replace(/[^\w-]/g, "").toLowerCase();
  const code = md.utils.escapeHtml(token.content);
  return `<pre class="md-code"><code${language ? ` class="language-${language}"` : ""}>${code}</code></pre>\n`;
};

/**
 * `$…$` / `$$…$$` become placeholders. KaTeX itself is loaded later by the
 * preview, so a formula that cannot be parsed still shows the original text.
 * Leading or trailing spaces inside single dollars are left alone (`$5 and $10`).
 */
function mathInline(
  state: {
    src: string;
    pos: number;
    posMax: number;
    push: (type: string, tag: string, nesting: 0 | 1 | -1) => { content: string; markup: string };
  },
  silent: boolean
): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x24) return false;

  const display = state.src.charCodeAt(start + 1) === 0x24;
  const marker = display ? 2 : 1;
  const open = start + marker;
  if (open >= state.posMax) return false;

  const close = state.src.indexOf(display ? "$$" : "$", open);
  if (close <= open) return false;
  const content = state.src.slice(open, close);
  if (content.includes("`")) return false;
  if (!display && (content.startsWith(" ") || content.endsWith(" ") || content.includes("\n"))) {
    return false;
  }
  if (display && (content.includes("\n") || content.trim() === "")) return false;

  if (!silent) {
    const token = state.push("math_inline", "span", 0);
    token.content = content;
    token.markup = display ? "$$" : "$";
  }
  state.pos = close + marker;
  return true;
}

function mathBlock(
  state: {
    src: string;
    bMarks: number[];
    eMarks: number[];
    tShift: number[];
    line: number;
    getLines: (begin: number, end: number, indent: number, keepLastLF: boolean) => string;
    push: (
      type: string,
      tag: string,
      nesting: 0 | 1 | -1
    ) => {
      content: string;
      map: [number, number] | null;
    };
  },
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  const openPos = state.bMarks[startLine] + state.tShift[startLine];
  const openMax = state.eMarks[startLine];
  if (openPos + 1 >= openMax) return false;
  if (state.src.charCodeAt(openPos) !== 0x24 || state.src.charCodeAt(openPos + 1) !== 0x24) {
    return false;
  }

  const first = state.src.slice(openPos, openMax).trim();
  let content: string;
  let nextLine: number;

  if (first.length > 4 && first.endsWith("$$") && !first.slice(2, -2).includes("$$")) {
    content = first.slice(2, -2).trim();
    if (!content) return false;
    nextLine = startLine + 1;
  } else if (first === "$$") {
    let cursor = startLine + 1;
    for (; cursor < endLine; cursor++) {
      const pos = state.bMarks[cursor] + state.tShift[cursor];
      const max = state.eMarks[cursor];
      if (state.src.slice(pos, max).trim() === "$$") break;
    }
    if (cursor >= endLine) return false;
    content = state.getLines(startLine + 1, cursor, state.tShift[startLine], false).trim();
    nextLine = cursor + 1;
  } else {
    return false;
  }

  if (silent) return true;
  const token = state.push("math_block", "div", 0);
  token.content = content;
  token.map = [startLine, nextLine];
  state.line = nextLine;
  return true;
}

md.inline.ruler.after("backticks", "math_inline", mathInline);
md.block.ruler.before("paragraph", "math_block", mathBlock);

const mathHtml = (content: string, display: boolean) => {
  const source = md.utils.escapeHtml(content);
  const dollars = display ? "$$" : "$";
  const tag = display ? "div" : "span";
  const kind = display ? "math-block" : "math-inline";
  return `<${tag} class="${kind}">${dollars}${source}${dollars}</${tag}>${display ? "\n" : ""}`;
};

md.renderer.rules.math_inline = (tokens, index) => {
  const display = tokens[index].markup === "$$";
  const source = md.utils.escapeHtml(tokens[index].content);
  const dollars = display ? "$$" : "$";
  const kind = display ? "math-inline math-display" : "math-inline";
  return `<span class="${kind}">${dollars}${source}${dollars}</span>`;
};

md.renderer.rules.math_block = (tokens, index) => mathHtml(tokens[index].content, true);

export function renderMarkdown(source: string, options: RenderOptions = {}): string {
  const env: RenderEnv = {
    tracker: createSlugTracker(),
    baseDir: options.baseDir,
    sourceLines: options.sourceLines,
  };
  return md.render(source, env as unknown as Record<string, unknown>);
}

/** True when the file should show the preview toggle by default. */
export function isMarkdownFile(filename: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(filename);
}
