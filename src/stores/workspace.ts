import { create } from "zustand";
import {
  DEFAULT_META,
  type DocumentMode,
  type FileMeta,
  type LargeFileInfo,
  type OpenedFile,
} from "../ipc/types";

export interface Tab {
  id: string;
  name: string;
  path: string | null;
  /** `text` tabs are edited in CodeMirror; `large` tabs are read-only ranges. */
  mode: DocumentMode;
  /** Last known buffer text. The live text of the active tab lives in CodeMirror
   *  and is flushed back here when the editor unmounts or the file is saved. */
  content: string;
  meta: FileMeta;
  size: number;
  mtimeMs: number;
  dirty: boolean;
  lines: number;
  chars: number;
  /** Bumped when the buffer is replaced from disk, which remounts the editor. */
  version: number;
}

interface WorkspaceState {
  tabs: Tab[];
  activeId: string | null;
  dragging: boolean;
  error: string | null;
  /** Transient success/info message (auto-cleared by the UI). */
  notice: string | null;
  recent: string[];

  newTab(): void;
  addTab(tab: Tab): void;
  setActive(id: string): void;
  closeTab(id: string): void;
  setContent(id: string, content: string, version?: number): void;
  markEdited(id: string, stats: { lines: number; chars: number }): void;
  markSaved(
    id: string,
    patch: { path: string; content: string; meta: FileMeta; size: number; mtimeMs: number }
  ): void;
  reloadTab(id: string, file: OpenedFile): void;
  /** Refresh a read-only large-file tab after the file changed on disk. */
  reloadLargeTab(id: string, info: LargeFileInfo): void;
  setDragging(value: boolean): void;
  setError(message: string | null): void;
  setNotice(message: string | null): void;
  setRecent(paths: string[]): void;
  /** Remove one entry from the recent list (e.g. deleted/moved file). */
  removeRecent(path: string): void;
}

export const countLines = (content: string): number =>
  content.length === 0 ? 1 : content.split("\n").length;

const nameOf = (path: string) => path.split(/[\\/]/).pop() || path;

const dedupe = (paths: string[], max = 12) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
};

/** Build the store representation of a freshly opened file. */
export const tabFromFile = (file: OpenedFile): Tab => ({
  id: crypto.randomUUID(),
  name: file.name,
  path: file.path,
  mode: "text",
  content: file.content,
  meta: file.meta,
  size: file.size,
  mtimeMs: file.mtimeMs,
  dirty: false,
  lines: countLines(file.content),
  chars: file.content.length,
  version: 0,
});

/** Read-only tab backed by `read_range`; the whole file never reaches the frontend. */
export const tabFromLarge = (info: LargeFileInfo): Tab => ({
  id: crypto.randomUUID(),
  name: info.name,
  path: info.path,
  mode: "large",
  content: "",
  meta: info.meta,
  size: info.size,
  mtimeMs: info.mtimeMs,
  dirty: false,
  lines: info.lineCount,
  chars: 0,
  version: 0,
});

export const useWorkspace = create<WorkspaceState>((set) => ({
  tabs: [],
  activeId: null,
  dragging: false,
  error: null,
  notice: null,
  recent: [],

  newTab: () => {
    const id = crypto.randomUUID();
    set((state) => ({
      tabs: [
        ...state.tabs,
        {
          id,
          name: `未命名 ${state.tabs.length + 1}`,
          path: null,
          mode: "text",
          content: "",
          meta: { ...DEFAULT_META },
          size: 0,
          mtimeMs: 0,
          dirty: false,
          lines: 1,
          chars: 0,
          version: 0,
        },
      ],
      activeId: id,
    }));
  },

  addTab: (tab) =>
    set((state) => {
      const existing = tab.path ? state.tabs.find((t) => t.path === tab.path) : undefined;
      if (existing) return { activeId: existing.id };
      return {
        tabs: [...state.tabs, tab],
        activeId: tab.id,
        recent: tab.path ? dedupe([tab.path, ...state.recent]) : state.recent,
      };
    }),

  setActive: (id) => set({ activeId: id }),

  closeTab: (id) =>
    set((state) => {
      const index = state.tabs.findIndex((t) => t.id === id);
      if (index === -1) return state;
      const tabs = state.tabs.filter((t) => t.id !== id);
      let activeId = state.activeId;
      if (state.activeId === id) {
        const next = tabs[index] ?? tabs[index - 1] ?? null;
        activeId = next ? next.id : null;
      }
      return { tabs, activeId };
    }),

  /** Buffer flushed from the editor (unmount). `version` guards against a stale
   *  view overwriting a buffer that was just reloaded from disk. */
  setContent: (id, content, version) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id && (version === undefined || t.version === version) ? { ...t, content } : t
      ),
    })),

  /** Called on every document change: O(1), never copies the whole buffer. */
  markEdited: (id, stats) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, dirty: true, lines: stats.lines, chars: stats.chars } : t
      ),
    })),

  markSaved: (id, patch) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              path: patch.path,
              name: nameOf(patch.path),
              content: patch.content,
              meta: patch.meta,
              size: patch.size,
              mtimeMs: patch.mtimeMs,
              dirty: false,
            }
          : t
      ),
      recent: dedupe([patch.path, ...state.recent]),
    })),

  reloadTab: (id, file) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              path: file.path,
              name: file.name,
              content: file.content,
              meta: file.meta,
              size: file.size,
              mtimeMs: file.mtimeMs,
              dirty: false,
              lines: countLines(file.content),
              chars: file.content.length,
              version: t.version + 1,
            }
          : t
      ),
    })),

  reloadLargeTab: (id, info) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              path: info.path,
              name: info.name,
              meta: info.meta,
              size: info.size,
              mtimeMs: info.mtimeMs,
              dirty: false,
              lines: info.lineCount,
              version: t.version + 1,
            }
          : t
      ),
    })),

  setDragging: (value) => set({ dragging: value }),
  setError: (message) => set({ error: message }),
  setNotice: (message) => set({ notice: message }),
  setRecent: (paths) => set({ recent: dedupe(paths) }),
  removeRecent: (path) =>
    set((state) => ({ recent: state.recent.filter((item) => item !== path) })),
}));

export const selectActiveTab = (state: WorkspaceState): Tab | null =>
  state.tabs.find((t) => t.id === state.activeId) ?? null;
