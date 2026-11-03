import { create } from "zustand";
import { isMarkdownFile } from "../features/markdown";
import { loadNewFileFormat } from "../features/newFileFormat";
import { t } from "../i18n/locale";
import { samePath } from "../lib/paths";
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
  /** Last opened or saved text. Keystrokes stay in the editor state, not here. */
  content: string;
  meta: FileMeta;
  size: number;
  mtimeMs: number;
  dirty: boolean;
  lines: number;
  chars: number;
  /** Bumped when the buffer is replaced from disk, which remounts the editor. */
  version: number;
  /** Kept for older callers. The preview itself is a separate tab (`previewOf`). */
  preview: boolean;
  /** Kept for older callers. The editor tab always shows the source. */
  source: boolean;
  /** When set, this tab renders that document and does not own a buffer. */
  previewOf: string | null;
}

/** `activeId` of the settings page. It is never an entry in `tabs`. */
export const SETTINGS_TAB_ID = "settings";

export type SettingsSection = "general" | "models" | "providers" | "limits" | "access" | "usage";

interface WorkspaceState {
  tabs: Tab[];
  /** A file tab id, `SETTINGS_TAB_ID`, or null for the welcome page. */
  activeId: string | null;
  /** The settings page sits after the file tabs while open. */
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  dragging: boolean;
  error: string | null;
  /** Transient success/info message (auto-cleared by the UI). */
  notice: string | null;
  recent: string[];

  newTab(): void;
  addTab(tab: Tab): void;
  setActive(id: string): void;
  closeTab(id: string): void;
  /** Open the settings page, or switch to it when it is already open. */
  openSettings(section?: SettingsSection): void;
  setSettingsSection(section: SettingsSection): void;
  closeSettings(): void;
  setContent(id: string, content: string, version?: number): void;
  markEdited(id: string, stats: { lines: number; chars: number }): void;
  markSaved(
    id: string,
    patch: { path: string; content: string; meta: FileMeta; size: number; mtimeMs: number }
  ): void;
  /** Point an open tab at a renamed file. The buffer and its dirty flag stay as they are. */
  renameTab(id: string, patch: { path: string; name: string; mtimeMs: number }): void;
  /** Update a tab's name only (unsaved buffer renamed in place). */
  setName(id: string, name: string): void;
  reloadTab(id: string, file: OpenedFile): void;
  /** Refresh a read-only large-file tab after the file changed on disk. */
  reloadLargeTab(id: string, info: LargeFileInfo): void;
  setDragging(value: boolean): void;
  setError(message: string | null): void;
  setNotice(message: string | null): void;
  setRecent(paths: string[]): void;
  /** Remove one entry from the recent list (e.g. deleted/moved file). */
  removeRecent(path: string): void;
  /** Turn Markdown preview on or off for one tab. Other tabs stay as they are. */
  setPreview(id: string, on: boolean): void;
  /** Show or hide the source editor for one tab. Markdown uses this for the `</>` split. */
  setSource(id: string, on: boolean): void;
  /** Open or focus the preview tab for a text document. */
  openPreview(sourceId: string): void;
}

export const countLines = (content: string): number =>
  content.length === 0 ? 1 : content.split("\n").length;

const nameOf = (path: string) => path.split(/[\\/]/).pop() || path;

function withPreviewName(tabs: Tab[], sourceId: string, name: string): Tab[] {
  return tabs.map((tab) => (tab.previewOf === sourceId ? { ...tab, name } : tab));
}

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
  preview: false,
  source: true,
  previewOf: null,
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
  preview: false,
  source: false,
  previewOf: null,
});

export const useWorkspace = create<WorkspaceState>((set) => ({
  tabs: [],
  activeId: null,
  settingsOpen: false,
  settingsSection: "general",
  dragging: false,
  error: null,
  notice: null,
  recent: [],

  newTab: () => {
    const id = crypto.randomUUID();
    const extension = loadNewFileFormat();
    set((state) => ({
      tabs: [
        ...state.tabs,
        {
          id,
          name: `${t("tab.untitled", { n: state.tabs.length + 1 })}.${extension}`,
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
          preview: false,
          source: true,
          previewOf: null,
        },
      ],
      activeId: id,
    }));
  },

  addTab: (tab) =>
    set((state) => {
      const existing = tab.path
        ? state.tabs.find((item) => item.path && samePath(item.path, tab.path as string))
        : undefined;
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
      const removed = new Set([id]);
      for (const tab of state.tabs) {
        if (tab.previewOf === id) removed.add(tab.id);
      }
      const tabs = state.tabs.filter((tab) => !removed.has(tab.id));
      let activeId = state.activeId;
      if (activeId && removed.has(activeId)) {
        const next =
          state.tabs.slice(index + 1).find((tab) => !removed.has(tab.id)) ??
          [...state.tabs]
            .slice(0, index)
            .reverse()
            .find((tab) => !removed.has(tab.id)) ??
          null;
        activeId = next ? next.id : state.settingsOpen ? SETTINGS_TAB_ID : null;
      }
      return { tabs, activeId };
    }),

  openSettings: (section) =>
    set((state) => ({
      settingsOpen: true,
      activeId: SETTINGS_TAB_ID,
      settingsSection: section ?? state.settingsSection,
    })),

  setSettingsSection: (section) => set({ settingsSection: section }),

  closeSettings: () =>
    set((state) => ({
      settingsOpen: false,
      activeId:
        state.activeId === SETTINGS_TAB_ID
          ? (state.tabs[state.tabs.length - 1]?.id ?? null)
          : state.activeId,
    })),

  /** Replaces the open/save snapshot. The live text stays in the editor state. */
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
    set((state) => {
      const name = nameOf(patch.path);
      return {
        tabs: withPreviewName(
          state.tabs.map((t) =>
            t.id === id
              ? {
                  ...t,
                  path: patch.path,
                  name,
                  content: patch.content,
                  meta: patch.meta,
                  size: patch.size,
                  mtimeMs: patch.mtimeMs,
                  dirty: false,
                }
              : t
          ),
          id,
          name
        ),
        recent: dedupe([patch.path, ...state.recent]),
      };
    }),

  renameTab: (id, patch) =>
    set((state) => {
      const previous = state.tabs.find((tab) => tab.id === id)?.path ?? null;
      return {
        tabs: withPreviewName(
          state.tabs.map((t) =>
            t.id === id
              ? {
                  ...t,
                  path: patch.path,
                  name: patch.name,
                  mtimeMs: patch.mtimeMs,
                  preview: isMarkdownFile(patch.name) ? t.preview : false,
                }
              : t
          ),
          id,
          patch.name
        ),
        recent: dedupe([
          patch.path,
          ...state.recent.filter((item) => !(previous !== null && samePath(item, previous))),
        ]),
      };
    }),

  setName: (id, name) =>
    set((state) => ({
      tabs: withPreviewName(
        state.tabs.map((t) =>
          t.id === id ? { ...t, name, preview: isMarkdownFile(name) ? t.preview : false } : t
        ),
        id,
        name
      ),
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

  setPreview: (id, on) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id && tab.mode === "text" ? { ...tab, preview: on } : tab
      ),
    })),

  setSource: (id, on) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id && tab.mode === "text" ? { ...tab, source: on } : tab
      ),
    })),

  openPreview: (sourceId) =>
    set((state) => {
      const source = state.tabs.find((tab) => tab.id === sourceId);
      if (!source || source.mode !== "text" || source.previewOf) return state;
      const existing = state.tabs.find((tab) => tab.previewOf === sourceId);
      if (existing) return { activeId: existing.id };
      const preview: Tab = {
        id: crypto.randomUUID(),
        name: source.name,
        path: null,
        mode: "text",
        content: "",
        meta: source.meta,
        size: source.size,
        mtimeMs: source.mtimeMs,
        dirty: false,
        lines: source.lines,
        chars: source.chars,
        version: 0,
        preview: false,
        source: false,
        previewOf: sourceId,
      };
      const index = state.tabs.findIndex((tab) => tab.id === sourceId);
      const tabs = [...state.tabs];
      tabs.splice(index + 1, 0, preview);
      return { tabs, activeId: preview.id };
    }),
}));

export const selectActiveTab = (state: WorkspaceState): Tab | null =>
  state.tabs.find((t) => t.id === state.activeId) ?? null;

/** The document a tab edits or previews. Preview tabs do not own a buffer. */
export function resolveDocument(state: WorkspaceState, tab: Tab | null): Tab | null {
  if (!tab) return null;
  if (!tab.previewOf) return tab;
  return state.tabs.find((item) => item.id === tab.previewOf) ?? null;
}
