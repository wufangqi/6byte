import type { AiMessage } from "../ipc/types";
import { parseDocument, sectionByTitle, sectionCovering } from "./documentModel";
import { isMarkdownFile } from "./markdown";

/** Lines kept on either side of the selection when there is no Markdown section. */
export const NEIGHBOR_LINES = 40;

/**
 * Room for the section, filename, and outline. The selection is never cut to
 * fit, and a section that does not fit is omitted rather than sending the file.
 */
export const CONTEXT_EXTRA_BUDGET = 8_000;

const REWRITE_SYSTEM =
  "按用户要求处理选区里的文字，只输出替换选区的正文，不要解释。若给出了所在章节、大纲或引用，沿用其中的术语和标题层级。引用的其他文件只作参考，不要输出它们的全文。";

export type ContextPartId =
  "selection" | "section" | "neighbors" | "filename" | "outline" | "references";

export interface RewriteSource {
  filename: string;
  /** Full buffer. Only a section or a neighbor window is sent. */
  document: string;
  /** Selection start, as a character offset into `document`. */
  from: number;
  /** Selection end, exclusive. */
  to: number;
}

export interface ContextPart {
  id: ContextPartId;
  /** The document has this piece. */
  available: boolean;
  /** It will be included in the request. */
  included: boolean;
  /** The user turned it off. */
  excluded: boolean;
  /** Omitted because the extra-context budget was full. */
  dropped: boolean;
}

export interface AssembleOptions {
  exclude?: readonly ContextPartId[];
  extraBudget?: number;
  /** Bounded text for `@` file and heading mentions. Empty means none. */
  references?: string;
}

interface Piece {
  id: ContextPartId;
  text: string;
}

const DROP_FIRST: ContextPartId[] = ["references", "outline", "filename", "section", "neighbors"];

export function assembleRewrite(
  selection: string,
  instruction: string,
  source: RewriteSource | null,
  options: AssembleOptions = {}
): { parts: ContextPart[]; messages: AiMessage[] } {
  const exclude = new Set(options.exclude ?? []);
  exclude.delete("selection");
  const budget = options.extraBudget ?? CONTEXT_EXTRA_BUDGET;
  const pieces = source ? contextPieces(source) : [];
  const references = options.references?.trim() ?? "";
  if (references) pieces.push({ id: "references", text: references });
  const dropped = new Set<ContextPartId>();
  const kept = pieces.filter((piece) => !exclude.has(piece.id));
  while (kept.reduce((sum, piece) => sum + piece.text.length, 0) > budget && kept.length > 0) {
    const index = lowestPriority(kept);
    dropped.add(kept[index].id);
    kept.splice(index, 1);
  }
  const included = new Set(kept.map((piece) => piece.id));
  const order: ContextPartId[] = [
    "selection",
    "section",
    "neighbors",
    "filename",
    "outline",
    "references",
  ];
  const byId = new Map(pieces.map((piece) => [piece.id, piece]));
  const parts: ContextPart[] = order.map((id) => ({
    id,
    available: id === "selection" || byId.has(id),
    included: id === "selection" || included.has(id),
    excluded: exclude.has(id),
    dropped: dropped.has(id),
  }));

  const blocks = kept.map((piece) => piece.text);
  blocks.push(`选区：\n${selection}`);
  blocks.push(`要求：\n${instruction.trim()}`);
  return {
    parts,
    messages: [
      { role: "system", content: REWRITE_SYSTEM },
      { role: "user", content: blocks.join("\n\n") },
    ],
  };
}

function contextPieces(source: RewriteSource): Piece[] {
  const pieces: Piece[] = [];
  const filename = source.filename.trim();
  if (filename) {
    const extension = fileExtension(filename);
    pieces.push({
      id: "filename",
      text: `文件：${filename}\n扩展名：${extension || "无"}`,
    });
  }

  const markdown = isMarkdownFile(filename);
  const model = markdown ? parseDocument(source.document) : null;
  const headings = model?.headings ?? [];
  if (headings.length > 0) {
    const outline = headings
      .map((heading) => `${"#".repeat(heading.level)} ${heading.text}`)
      .join("\n");
    pieces.push({ id: "outline", text: `大纲：\n${outline}` });
  }

  const starts = lineStarts(source.document);
  const fromLine = lineOf(starts, source.from);
  const toLine = lineOf(starts, Math.max(source.from, source.to - 1));
  const section = model ? sectionCovering(model, fromLine) : null;
  if (section) {
    pieces.push({
      id: "section",
      text: `所在章节：\n${sliceLines(source.document, starts, section.line, section.endLine)}`,
    });
    return pieces;
  }

  const neighborFrom = Math.max(1, fromLine - NEIGHBOR_LINES);
  const neighborTo = Math.min(starts.length, toLine + NEIGHBOR_LINES);
  pieces.push({
    id: "neighbors",
    text: `邻近文字：\n${sliceLines(source.document, starts, neighborFrom, neighborTo)}`,
  });
  return pieces;
}

function lowestPriority(pieces: readonly Piece[]): number {
  let index = 0;
  let rank = DROP_FIRST.indexOf(pieces[0].id);
  for (let i = 1; i < pieces.length; i++) {
    const next = DROP_FIRST.indexOf(pieces[i].id);
    if (next >= 0 && (rank < 0 || next < rank)) {
      index = i;
      rank = next;
    }
  }
  return index;
}

function fileExtension(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot);
}

function lineStarts(doc: string): number[] {
  const starts = [0];
  for (let i = 0; i < doc.length; i++) {
    if (doc.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineOf(starts: readonly number[], pos: number): number {
  const clamped = Math.max(0, Math.min(pos, Number.MAX_SAFE_INTEGER));
  let line = 1;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= clamped) line = i + 1;
    else break;
  }
  return line;
}

function sliceLines(
  doc: string,
  starts: readonly number[],
  startLine: number,
  endLine: number
): string {
  const from = starts[Math.max(0, startLine - 1)] ?? 0;
  const to = endLine >= starts.length ? doc.length : (starts[endLine] ?? doc.length);
  return doc.slice(from, to).replace(/(?:\r\n|\n)$/, "");
}

/** The Markdown section for one heading, or null when that title is not in the document. */
export function sectionForHeading(document: string, title: string, line?: number): string | null {
  const model = parseDocument(document);
  const heading = sectionByTitle(model, title, line);
  if (!heading) return null;
  return sliceLines(document, lineStarts(document), heading.line, heading.endLine);
}
