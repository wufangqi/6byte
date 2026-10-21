import { create } from "zustand";
import { DEFAULT_META, type FileMeta } from "../ipc/types";

export interface Tab {
  id: string;
  name: string;
  path: string | null;
  content: string;
  meta: FileMeta;
  size: number;
  mtimeMs: number;
  dirty: boolean;
}

interface WorkspaceState {
  tabs: Tab[];
  activeId: string | null;
  dragging: boolean;
  error: string | null;
  recent: string[];

  newTab(): void;
  addTab(tab: Tab): void;
  setActive(id: string): void;
  closeTab(id: string): void;
  updateContent(id: string, content: string): void;
  markSaved(
    id: string,
    patch: { path: string; meta: FileMeta; size: number; mtimeMs: number }
  ): void;
  setDragging(value: boolean): void;
  setError(message: string | null): void;
  addRecent(paths: string[]): void;
  setRecent(paths: string[]): void;
}

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

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  tabs: [],
  activeId: null,
  dragging: false,
  error: null,
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
          content: "",
          meta: { ...DEFAULT_META },
          size: 0,
          mtimeMs: 0,
          dirty: false,
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

  updateContent: (id, content) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, content, dirty: true } : t)),
    })),

  markSaved: (id, patch) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              path: patch.path,
              name: nameOf(patch.path),
              meta: patch.meta,
              size: patch.size,
              mtimeMs: patch.mtimeMs,
              dirty: false,
            }
          : t
      ),
      recent: dedupe([patch.path, ...state.recent]),
    })),

  setDragging: (value) => set({ dragging: value }),
  setError: (message) => set({ error: message }),
  addRecent: (paths) => set((state) => ({ recent: dedupe([...paths, ...state.recent]) })),
  setRecent: (paths) => set({ recent: dedupe(paths) }),
}));

export const selectActiveTab = (state: WorkspaceState): Tab | null =>
  state.tabs.find((t) => t.id === state.activeId) ?? null;

export const getActiveTab = (): Tab | null => selectActiveTab(useWorkspace.getState());