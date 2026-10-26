import { samePath } from "../lib/paths";

export const TREE_PAGE_SIZE = 300;
export const DEFAULT_TREE_WIDTH = 240;
export const MIN_TREE_WIDTH = 160;
export const MAX_TREE_WIDTH = 400;
export const MAX_EXPANDED_DIRS = 200;
export const MAX_TREE_NODES = 5_000;

export interface TreeEntry {
  name: string;
  kind: "dir" | "file";
}

export interface TreeNode extends TreeEntry {
  path: string;
  children?: TreeNode[];
  state: "idle" | "loading" | "ready" | "error";
  error?: string;
  expanded?: boolean;
  truncated?: boolean;
  limit?: number;
}

export interface TreeRow {
  node: TreeNode;
  depth: number;
}

export function clampTreeWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TREE_WIDTH;
  return Math.min(MAX_TREE_WIDTH, Math.max(MIN_TREE_WIDTH, Math.round(value)));
}

export function parseTreeWidth(raw: string | null): number {
  if (raw == null || raw.trim() === "") return DEFAULT_TREE_WIDTH;
  return clampTreeWidth(Number(raw));
}

export function parseTreeHidden(raw: string | null): boolean {
  return raw === "1";
}

function windowsPath(value: string): boolean {
  return value.includes("\\") || /^[A-Za-z]:/.test(value);
}

/** Drop `\\?\` / `\\?\UNC\` so canonical paths compare with dialog paths. */
function withoutVerbatim(value: string): string {
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}

/** True when `candidate` is the root or a path under it. */
export function pathInsideRoot(root: string, candidate: string): boolean {
  const windows = windowsPath(root) || windowsPath(candidate);
  const normalize = (value: string) => {
    const trimmed = withoutVerbatim(value).replace(/[\\/]+$/, "");
    return windows ? trimmed.replace(/\//g, "\\").toLowerCase() : trimmed;
  };
  const base = normalize(root);
  const path = normalize(candidate);
  if (!base || !path) return false;
  const separator = windows ? "\\" : "/";
  return path === base || path.startsWith(`${base}${separator}`);
}

/** Highlight only the active file when it lives under the current root. */
export function treeHighlights(
  root: string | null,
  activePath: string | null,
  nodePath: string
): boolean {
  if (!root || !activePath) return false;
  if (!pathInsideRoot(root, activePath)) return false;
  return samePath(nodePath, activePath);
}

export function sortTreeEntries<T extends TreeEntry>(entries: readonly T[], locale: string): T[] {
  const collator = new Intl.Collator(locale === "zh" ? "zh" : "en");
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
    return collator.compare(left.name, right.name);
  });
}

export function visibleTreeRows(nodes: readonly TreeNode[] | undefined, depth = 0): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const node of nodes ?? []) {
    rows.push({ node, depth });
    if (node.kind === "dir" && node.expanded) {
      rows.push(...visibleTreeRows(node.children, depth + 1));
    }
  }
  return rows;
}

export function pageRows<T>(rows: readonly T[], shown: number): T[] {
  return rows.slice(0, Math.max(0, shown));
}

export function treeStats(root: TreeNode | null): { nodes: number; expanded: number } {
  let nodes = 0;
  let expanded = 0;
  const walk = (node: TreeNode) => {
    nodes += 1;
    if (node.kind === "dir" && node.expanded) expanded += 1;
    node.children?.forEach(walk);
  };
  if (root) walk(root);
  return { nodes, expanded };
}

/** Refuse another expansion once the hard caps in the PRD are reached. */
export function canExpand(stats: { nodes: number; expanded: number }, incoming: number): boolean {
  return stats.expanded < MAX_EXPANDED_DIRS && stats.nodes + incoming <= MAX_TREE_NODES;
}

export function findTreeNode(root: TreeNode | null, path: string): TreeNode | null {
  if (!root) return null;
  if (samePath(root.path, path)) return root;
  for (const child of root.children ?? []) {
    const found = findTreeNode(child, path);
    if (found) return found;
  }
  return null;
}

export function updateTreeNode(
  root: TreeNode,
  path: string,
  update: (node: TreeNode) => TreeNode
): TreeNode {
  if (samePath(root.path, path)) return update(root);
  if (!root.children) return root;
  let changed = false;
  const children = root.children.map((child) => {
    const next = updateTreeNode(child, path, update);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...root, children } : root;
}

export function expandedPaths(root: TreeNode | null): string[] {
  const paths: string[] = [];
  const walk = (node: TreeNode) => {
    if (node.kind === "dir" && node.expanded) {
      paths.push(node.path);
      node.children?.forEach(walk);
    }
  };
  if (root) walk(root);
  return paths;
}
