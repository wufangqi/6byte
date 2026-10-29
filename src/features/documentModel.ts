import { createSlugTracker, plainHeadingText, slugFor } from "./markdown";

/**
 * Markdown structure shared by the outline, command palette, rewrite context,
 * `@` mentions and the read-only ask outline (T72).
 *
 * One left-to-right scan. It is not a full CommonMark parser: ATX headings,
 * fenced code, a leading frontmatter block, paragraphs, inline links and images.
 */

export interface OutlineItem {
  level: number;
  text: string;
  slug: string;
  /** 1-based source line. */
  line: number;
}

export interface HeadingNode extends OutlineItem {
  /** 1-based, inclusive. The section runs through the line before the next sibling. */
  endLine: number;
  children: HeadingNode[];
}

export type BlockKind = "frontmatter" | "heading" | "code" | "paragraph";

export interface SourceBlock {
  kind: BlockKind;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  text: string;
  /** Info string of a fence, such as `ts`. Empty for other blocks. */
  language: string;
}

export interface DocumentLink {
  kind: "link" | "image";
  text: string;
  href: string;
  /** 1-based line of the opening bracket. */
  line: number;
}

export interface DocumentModel {
  headings: OutlineItem[];
  tree: HeadingNode[];
  blocks: SourceBlock[];
  /** Closed `---` block at the start of the file, or null. */
  frontmatter: string | null;
  links: DocumentLink[];
  /** Image targets that are not http, data or mailto URLs. */
  resources: DocumentLink[];
}

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^---\s*$/;
const INLINE = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export function parseDocument(source: string): DocumentModel {
  if (source.length === 0) return emptyModel();
  const lines = source.split(/\r?\n/);
  const frontmatterEnd = closedFrontmatter(lines);
  const headings: OutlineItem[] = [];
  const blocks: SourceBlock[] = [];
  const links: DocumentLink[] = [];
  const tracker = createSlugTracker();
  let fence: string | null = null;
  let fenceStart = -1;
  let fenceLanguage = "";
  let paragraphStart = -1;

  const flushParagraph = (end: number) => {
    if (paragraphStart < 0) return;
    const text = lines.slice(paragraphStart, end).join("\n");
    blocks.push({
      kind: "paragraph",
      startLine: paragraphStart + 1,
      endLine: end,
      text,
      language: "",
    });
    collectLinks(text, paragraphStart + 1, links);
    paragraphStart = -1;
  };

  if (frontmatterEnd > 0) {
    blocks.push({
      kind: "frontmatter",
      startLine: 1,
      endLine: frontmatterEnd,
      text: lines.slice(1, frontmatterEnd - 1).join("\n"),
      language: "",
    });
  }

  for (let index = frontmatterEnd; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[2][0];
      if (fence === null) {
        flushParagraph(index);
        fence = marker;
        fenceStart = index;
        fenceLanguage = fenceMatch[3].trim().split(/\s+/)[0] ?? "";
      } else if (fence === marker) {
        blocks.push({
          kind: "code",
          startLine: fenceStart + 1,
          endLine: index + 1,
          text: lines.slice(fenceStart + 1, index).join("\n"),
          language: fenceLanguage,
        });
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph(index);
      const raw = heading[2].trim();
      const item: OutlineItem = {
        level: heading[1].length,
        text: plainHeadingText(raw),
        slug: slugFor(raw, tracker),
        line: index + 1,
      };
      headings.push(item);
      blocks.push({
        kind: "heading",
        startLine: item.line,
        endLine: item.line,
        text: item.text,
        language: "",
      });
      collectLinks(line, item.line, links);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph(index);
      continue;
    }
    if (paragraphStart < 0) paragraphStart = index;
  }
  flushParagraph(lines.length);

  const tree = headingTree(headings, lines.length);
  const resources = links.filter(
    (link) => link.kind === "image" && !/^(?:https?:|data:|mailto:)/i.test(link.href)
  );
  return {
    headings,
    tree,
    blocks,
    frontmatter: frontmatterEnd > 0 ? lines.slice(1, frontmatterEnd - 1).join("\n") : null,
    links,
    resources,
  };
}

/** Nearest heading at or above `line`, through the line before the next sibling. */
export function sectionCovering(model: DocumentModel, line: number): HeadingNode | null {
  const flat = flatten(model.tree);
  return [...flat].reverse().find((heading) => heading.line <= line) ?? null;
}

/** The section whose heading text matches, preferring an exact line when given. */
export function sectionByTitle(
  model: DocumentModel,
  title: string,
  line?: number
): HeadingNode | null {
  const flat = flatten(model.tree);
  return (
    flat.find((heading) => heading.text === title && (line == null || heading.line === line)) ??
    flat.find((heading) => heading.text === title) ??
    null
  );
}

function emptyModel(): DocumentModel {
  return { headings: [], tree: [], blocks: [], frontmatter: null, links: [], resources: [] };
}

function closedFrontmatter(lines: readonly string[]): number {
  if (!RULE.test(lines[0] ?? "")) return 0;
  for (let index = 1; index < lines.length; index += 1) {
    if (RULE.test(lines[index])) return index + 1;
  }
  return 0;
}

function collectLinks(text: string, startLine: number, links: DocumentLink[]): void {
  INLINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE.exec(text))) {
    const before = text.slice(0, match.index);
    const line = startLine + (before.match(/\n/g)?.length ?? 0);
    links.push({
      kind: match[1] === "!" ? "image" : "link",
      text: match[2],
      href: match[3],
      line,
    });
  }
}

function headingTree(headings: readonly OutlineItem[], lineCount: number): HeadingNode[] {
  const nodes: HeadingNode[] = headings.map((heading) => ({
    ...heading,
    endLine: lineCount,
    children: [],
  }));
  const roots: HeadingNode[] = [];
  const stack: HeadingNode[] = [];
  for (const node of nodes) {
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  for (let index = 0; index < nodes.length; index += 1) {
    const next = nodes.slice(index + 1).find((node) => node.level <= nodes[index].level);
    nodes[index].endLine = next ? next.line - 1 : lineCount;
  }
  return roots;
}

function flatten(nodes: readonly HeadingNode[]): HeadingNode[] {
  const flat: HeadingNode[] = [];
  const visit = (node: HeadingNode) => {
    flat.push(node);
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return flat;
}
