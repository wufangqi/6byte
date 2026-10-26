import { create } from "zustand";
import {
  canExpand,
  expandedPaths,
  findTreeNode,
  MAX_EXPANDED_DIRS,
  MAX_TREE_NODES,
  parseTreeHidden,
  parseTreeWidth,
  sortTreeEntries,
  treeStats,
  updateTreeNode,
  type TreeNode,
} from "../features/fileTree";
import { getLocale, t } from "../i18n/locale";
import { currentWindowOwnsSession, listDirChildren, type DirListing } from "../ipc/api";
import { localizeError } from "../i18n";
import { fileName } from "../lib/paths";
import { useWorkspace } from "./workspace";

const WORKSPACE_KEY = "ainative.workspace";
const WIDTH_KEY = "ainative.treeWidth";
const HIDDEN_KEY = "ainative.treeHidden";

interface PersistedWorkspace {
  version: 1;
  rootPath: string;
}

interface FileTreeState {
  rootPath: string | null;
  rootName: string;
  root: TreeNode | null;
  hidden: boolean;
  width: number;
  selectedPath: string | null;
  focusRequest: number;
  openRoot(path: string): Promise<void>;
  closeRoot(): void;
  setHidden(hidden: boolean): void;
  toggleHidden(): void;
  setWidth(width: number): void;
  select(path: string): void;
  requestFocus(): void;
  toggleDir(path: string): Promise<void>;
  retryDir(path: string): Promise<void>;
  refresh(): Promise<void>;
  restore(): Promise<void>;
}

const loads = new Map<string, number>();
let loadSerial = 0;

function readStoredRoot(): string | null {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedWorkspace;
    if (parsed?.version !== 1 || typeof parsed.rootPath !== "string" || !parsed.rootPath) {
      return null;
    }
    return parsed.rootPath;
  } catch {
    return null;
  }
}

function writeStoredRoot(path: string | null) {
  if (!currentWindowOwnsSession()) return;
  try {
    if (!path) localStorage.removeItem(WORKSPACE_KEY);
    else localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ version: 1, rootPath: path }));
  } catch {
    /* ignore storage errors */
  }
}

function writePref(key: string, value: string) {
  if (!currentWindowOwnsSession()) return;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore storage errors */
  }
}

function entryNode(entry: { name: string; path: string; kind: "dir" | "file" }): TreeNode {
  return {
    name: entry.name,
    path: entry.path,
    kind: entry.kind,
    state: "idle",
  };
}

function applyListing(node: TreeNode, listing: DirListing): TreeNode {
  const children = sortTreeEntries(
    listing.entries.map((entry) => {
      const previous = node.children?.find((child) => child.path === entry.path);
      if (previous && previous.kind === entry.kind) return previous;
      return entryNode(entry);
    }),
    getLocale()
  );
  return {
    ...node,
    state: "ready",
    error: undefined,
    expanded: true,
    children,
    truncated: listing.truncated,
    limit: listing.limit,
  };
}

function invalidRootMessage(message: string): boolean {
  return /不是文件夹|没有权限|路径不存在|os error 2|os error 3|not found|cannot find|access is denied/i.test(
    message
  );
}

function failRoot(message: string) {
  writeStoredRoot(null);
  useFileTree.setState({ rootPath: null, rootName: "", root: null, selectedPath: null });
  useWorkspace.getState().setError(message);
}

export const useFileTree = create<FileTreeState>((set, get) => ({
  rootPath: null,
  rootName: "",
  root: null,
  hidden: parseTreeHidden(
    typeof localStorage === "undefined" ? null : localStorage.getItem(HIDDEN_KEY)
  ),
  width: parseTreeWidth(
    typeof localStorage === "undefined" ? null : localStorage.getItem(WIDTH_KEY)
  ),
  selectedPath: null,
  focusRequest: 0,

  openRoot: async (path) => {
    const name = fileName(path);
    // Keep the last collapsed/visible choice across restarts and folder changes.
    const hidden = get().hidden;
    set({
      rootPath: path,
      rootName: name,
      selectedPath: null,
      hidden,
      root: { name, path, kind: "dir", state: "loading", expanded: true },
    });
    writeStoredRoot(path);
    try {
      const listing = await listDirChildren(path);
      if (get().rootPath !== path) return;
      const root = get().root;
      if (!root) return;
      set({ root: applyListing(root, listing) });
    } catch (error) {
      if (get().rootPath !== path) return;
      failRoot(localizeError(error));
    }
  },

  closeRoot: () => {
    loads.clear();
    writeStoredRoot(null);
    set({ rootPath: null, rootName: "", root: null, selectedPath: null });
  },

  setHidden: (hidden) => {
    writePref(HIDDEN_KEY, hidden ? "1" : "0");
    set({ hidden });
  },

  toggleHidden: () => {
    const hidden = !get().hidden;
    get().setHidden(hidden);
  },

  setWidth: (width) => {
    writePref(WIDTH_KEY, String(width));
    set({ width });
  },

  select: (path) => set({ selectedPath: path }),

  requestFocus: () => set((state) => ({ focusRequest: state.focusRequest + 1 })),

  toggleDir: async (path) => {
    const node = findTreeNode(get().root, path);
    if (!node || node.kind !== "dir") return;
    const root = get().root;
    if (!root) return;
    if (node.expanded) {
      set({ root: updateTreeNode(root, path, (current) => ({ ...current, expanded: false })) });
      return;
    }
    if (node.children && node.state === "ready") {
      if (!canExpand(treeStats(root), 0)) {
        useWorkspace.getState().setNotice(t("tree.tooMany"));
        return;
      }
      set({ root: updateTreeNode(root, path, (current) => ({ ...current, expanded: true })) });
      return;
    }
    await get().retryDir(path);
  },

  retryDir: async (path) => {
    const currentRoot = get().root;
    const node = findTreeNode(currentRoot, path);
    if (!node || node.kind !== "dir" || !currentRoot) return;
    const token = ++loadSerial;
    loads.set(path, token);
    set({
      root: updateTreeNode(currentRoot, path, (current) => ({
        ...current,
        state: "loading",
        error: undefined,
        expanded: true,
      })),
    });
    try {
      const listing = await listDirChildren(path);
      if (loads.get(path) !== token || !get().root) return;
      const latest = get().root;
      if (!latest) return;
      const incoming = listing.entries.length;
      const stats = treeStats(latest);
      const already = node.children?.length ?? 0;
      const withinCaps =
        stats.expanded <= MAX_EXPANDED_DIRS &&
        stats.nodes + Math.max(0, incoming - already) <= MAX_TREE_NODES;
      if (!withinCaps) {
        useWorkspace.getState().setNotice(t("tree.tooMany"));
        set({
          root: updateTreeNode(latest, path, (current) => ({
            ...current,
            state: node.children ? "ready" : "idle",
            expanded: false,
          })),
        });
        return;
      }
      set({
        root: updateTreeNode(latest, path, (current) => applyListing(current, listing)),
      });
    } catch (error) {
      const latest = get().root;
      if (loads.get(path) !== token || !latest) return;
      const message = localizeError(error);
      if (path === get().rootPath && invalidRootMessage(message)) {
        failRoot(message);
        return;
      }
      set({
        root: updateTreeNode(latest, path, (current) => ({
          ...current,
          state: "error",
          error: message,
          expanded: true,
        })),
      });
    }
  },

  refresh: async () => {
    const root = get().root;
    if (!root) return;
    const paths = expandedPaths(root);
    for (const path of paths) {
      if (!findTreeNode(get().root, path)) continue;
      await get().retryDir(path);
    }
  },

  restore: async () => {
    if (!currentWindowOwnsSession()) return;
    const path = readStoredRoot();
    if (!path) return;
    await get().openRoot(path);
  },
}));
