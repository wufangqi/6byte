import { pathInsideRoot, type TreeNode } from "./fileTree";
import { isMarkdownFile } from "./markdown";
import { extractHeadings } from "./outline";
import { sectionForHeading } from "./rewriteContext";

/** How many workspace files the palette and `@` picker keep in memory. */
export const WORKSPACE_FILE_CAP = 400;
/** Non-markdown file mentions send only this many leading lines. */
export const FILE_REFERENCE_LINES = 40;
/** Markdown file mentions send headings, not section bodies. */
export const FILE_REFERENCE_HEADINGS = 80;

export interface WorkspaceFile {
  name: string;
  path: string;
}

export interface PaletteItem {
  id: string;
  kind: "file" | "heading" | "recent";
  label: string;
  detail: string;
  path?: string;
  line?: number;
}

export interface Mention {
  kind: "file" | "heading";
  label: string;
  line?: number;
}

export interface DirPage {
  entries: { name: string; path: string; kind: string }[];
}

/** Search starts at the open workspace. A file's own folder is only the fallback. */
export function grepDefaultRoot(
  workspaceRoot: string | null,
  fileDir: string | null
): string | null {
  const workspace = workspaceRoot?.trim() ?? "";
  if (workspace) return workspace;
  const folder = fileDir?.trim() ?? "";
  return folder || null;
}

export function relativePath(root: string, path: string): string {
  if (!pathInsideRoot(root, path)) return path.replace(/\\/g, "/");
  const windows = root.includes("\\") || /^[A-Za-z]:/.test(root);
  const clean = (value: string) => value.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const base = clean(root);
  const full = clean(path);
  const compareBase = windows ? base.toLowerCase() : base;
  const compareFull = windows ? full.toLowerCase() : full;
  if (compareFull === compareBase) return "";
  if (compareFull.startsWith(`${compareBase}/`)) return full.slice(base.length + 1);
  return full;
}

export function flattenTreeFiles(node: TreeNode | null): WorkspaceFile[] {
  if (!node) return [];
  const files: WorkspaceFile[] = [];
  const walk = (current: TreeNode) => {
    if (current.kind === "file") files.push({ name: current.name, path: current.path });
    for (const child of current.children ?? []) walk(child);
  };
  walk(node);
  return files;
}

/** Breadth-first file list. Stops at `limit` so a large tree cannot be loaded whole. */
export async function collectWorkspaceFiles(
  root: string,
  listDir: (path: string) => Promise<DirPage>,
  limit = WORKSPACE_FILE_CAP
): Promise<WorkspaceFile[]> {
  const files: WorkspaceFile[] = [];
  const queue = [root];
  const seen = new Set<string>();
  while (queue.length > 0 && files.length < limit) {
    const dir = queue.shift();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    let page: DirPage;
    try {
      page = await listDir(dir);
    } catch {
      continue;
    }
    for (const entry of page.entries) {
      if (entry.kind === "dir") queue.push(entry.path);
      else if (files.length < limit) files.push({ name: entry.name, path: entry.path });
    }
  }
  return files;
}

export function filterPalette(
  items: readonly PaletteItem[],
  query: string,
  limit = 40
): PaletteItem[] {
  const needle = query.trim().toLowerCase();
  const matched = needle
    ? items.filter(
        (item) =>
          item.label.toLowerCase().includes(needle) || item.detail.toLowerCase().includes(needle)
      )
    : [...items];
  return matched.slice(0, limit);
}

export function mentionToken(mention: Mention): string {
  if (mention.kind === "heading" && mention.line) {
    return `@{heading:${mention.line}:${mention.label}}`;
  }
  return `@{${mention.kind}:${mention.label}}`;
}

export function parseMentions(text: string): Mention[] {
  const found: Mention[] = [];
  for (const match of text.matchAll(/@\{(file|heading):([^}]+)\}/g)) {
    const kind = match[1] === "file" ? "file" : "heading";
    const raw = match[2].trim();
    if (!raw) continue;
    let label = raw;
    let line: number | undefined;
    if (kind === "heading") {
      const numbered = raw.match(/^(\d+):(.*)$/);
      if (numbered) {
        line = Number(numbered[1]);
        label = numbered[2].trim();
      }
    }
    if (!label) continue;
    if (found.some((item) => item.kind === kind && item.label === label && item.line === line)) {
      continue;
    }
    found.push({ kind, label, line });
  }
  return found;
}

/** The `@query` being typed at the caret, or null when the caret is not in one. */
export function activeMentionQuery(text: string, caret: number): string | null {
  const before = text.slice(0, Math.max(0, caret));
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1] ?? "")) return null;
  const fragment = before.slice(at + 1);
  if (fragment.startsWith("{") || /[\s}]/.test(fragment)) return null;
  return fragment;
}

export function insertMention(
  text: string,
  caret: number,
  query: string,
  token: string
): { text: string; caret: number } {
  const start = caret - query.length - 1;
  const typed = start >= 0 ? text.slice(start, caret) : "";
  if (typed === `@${query}`) {
    const next = `${text.slice(0, start)}${token} ${text.slice(caret)}`;
    return { text: next, caret: start + token.length + 1 };
  }
  const next = `${text.slice(0, caret)}${token} ${text.slice(caret)}`;
  return { text: next, caret: caret + token.length + 1 };
}

export function instructionWithoutMentions(text: string): string {
  return text
    .replace(/@\{(?:file|heading):[^}]+\}/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** A file the workspace index actually listed. Typed paths outside that list are refused. */
export function resolveFileTarget(
  files: readonly WorkspaceFile[],
  root: string | null,
  label: string
): string | null {
  const wanted = label.replace(/\\/g, "/");
  for (const file of files) {
    if (file.path === label || file.name === label) return file.path;
    if (root && relativePath(root, file.path) === wanted) return file.path;
  }
  return null;
}

/** Markdown mentions send the heading list. Other files send the first 40 lines. */
export function boundedFileExcerpt(filename: string, content: string): string {
  if (isMarkdownFile(filename)) {
    const headings = extractHeadings(content).slice(0, FILE_REFERENCE_HEADINGS);
    if (headings.length > 0) {
      const outline = headings
        .map((heading) => `${"#".repeat(heading.level)} ${heading.text}`)
        .join("\n");
      return `引用文件：${filename}\n大纲：\n${outline}`;
    }
  }
  const lines = content.split(/\r?\n/).slice(0, FILE_REFERENCE_LINES);
  return `引用文件：${filename}\n${lines.join("\n")}`;
}

export async function buildReferences(
  mentions: readonly Mention[],
  document: string,
  files: readonly WorkspaceFile[],
  root: string | null,
  readFile: (path: string) => Promise<{ name: string; content: string }>
): Promise<string> {
  const chunks: string[] = [];
  for (const mention of mentions) {
    if (mention.kind === "heading") {
      const section = sectionForHeading(document, mention.label, mention.line);
      chunks.push(
        section
          ? `引用大纲：${mention.label}\n${section}`
          : `引用大纲：${mention.label}\n未在当前文档找到这个标题。`
      );
      continue;
    }
    const path = resolveFileTarget(files, root, mention.label);
    if (!path) {
      chunks.push(`引用文件：${mention.label}\n不在当前工作区。`);
      continue;
    }
    try {
      const opened = await readFile(path);
      chunks.push(boundedFileExcerpt(opened.name || mention.label, opened.content));
    } catch {
      chunks.push(`引用文件：${mention.label}\n未能读取。`);
    }
  }
  return chunks.join("\n\n");
}
