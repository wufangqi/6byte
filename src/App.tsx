import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import EditorHost from "./editor/EditorHost";
import GrepPanel from "./features/GrepPanel";
import {
  DEFAULT_SPLIT_PERCENT,
  MAX_SPLIT_PERCENT,
  MIN_SPLIT_PERCENT,
  SPLIT_KEYBOARD_STEP,
  adjustSplitPercent,
  clampSplitPercent,
  normalizeSplitPercent,
} from "./features/splitPane";
import LargeFileViewer from "./features/LargeFileViewer";
import MarkdownPreview from "./features/MarkdownPreview";
import SettingsPage from "./features/SettingsPage";
import { AboutDialog, ShortcutsDialog } from "./features/HelpDialogs";
import AiSelectionAction from "./features/AiSelectionAction";
import AiStreamPanel from "./features/AiStreamPanel";
import {
  AI_PANEL_DEFAULT_WIDTH,
  AI_PANEL_KEYBOARD_STEP,
  clampAiPanelWidth,
} from "./features/aiPanelLayout";
import { activeModel, loadAiSettings } from "./features/aiSettings";
import MenuBar from "./features/MenuBar";
import StatusBar from "./features/StatusBar";
import TabBar from "./features/TabBar";
import FileTree from "./features/WorkspaceTree";
import Welcome from "./features/Welcome";
import { clampTreeWidth } from "./features/fileTree";
import { ask } from "./features/dialogStore";
import { askName } from "./features/renamePrompt";
import RenameDialog from "./features/RenameDialog";
import { extensionOf, withExtension } from "./features/fileName";
import { duplicateTab, isWatcherEcho, statConflicts } from "./features/fileSafety";
import CommandPalette from "./features/CommandPalette";
import { isAppShortcutBlocked } from "./features/shortcuts";
import { useFileWatch } from "./features/useFileWatch";
import { grepDefaultRoot } from "./features/workspaceQuery";
import DialogHost from "./features/Dialog";
import {
  currentWindowOwnsSession,
  isTauri,
  onCloseRequested,
  onFileDrop,
  openDocument,
  openFeedback,
  openNewWindow,
  pickDirectory,
  pickOpenPaths,
  pickSavePath,
  renameFile,
  saveAsset,
  statFile,
  writeFile,
} from "./ipc/api";
import { readBuffer, revealLineWhenReady } from "./editor/registry";
import { dismissRewriteForSave } from "./editor/rewriteGate";
import { dropDocStatesExcept } from "./editor/docStates";
import { DEFAULT_META, type FileChangeEvent } from "./ipc/types";
import { localizeError, t as tr, useI18n } from "./i18n";
import { formatSize, formatTime } from "./lib/format";
import { joinPath, parentDir, samePath } from "./lib/paths";
import { useFileTree } from "./stores/fileTree";
import { buildHtmlDocument, htmlPathFor, inlineLocalImages } from "./features/exportHtml";
import { getResolvedTheme } from "./features/theme";
import { loadImageDataUrl } from "./features/images";
import { isMarkdownFile } from "./features/markdown";
import { rememberMarkdownSource } from "./features/markdownView";
import {
  SETTINGS_TAB_ID,
  selectActiveTab,
  tabFromFile,
  tabFromLarge,
  useWorkspace,
} from "./stores/workspace";

const SESSION_KEY = "ainative.session";
const RECENT_KEY = "ainative.recent";
const SPLIT_KEY = "ainative.splitPercent";
const AI_PANEL_WIDTH_KEY = "ainative.aiPanelWidth";
const AI_FLOATING_MARKER_KEY = "ainative.aiFloatingMarker";
const SESSION_DEBOUNCE_MS = 500;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface OpenFailure {
  path: string;
  reason: string;
}

/** Missing files are expected after a session restore; say so in plain language. */
const friendlyReason = (error: unknown): string => {
  const message = errorMessage(error);
  return /os error 2|找不到|not found/i.test(message)
    ? tr("app.fileMissing")
    : localizeError(error);
};

const EOL_LABEL: Record<string, string> = { lf: "LF", crlf: "CRLF", cr: "CR" };

export default function App() {
  const active = useWorkspace(selectActiveTab);
  const settingsActive = useWorkspace((state) => state.activeId === SETTINGS_TAB_ID);
  const notice = useWorkspace((state) => state.notice);
  const [grepOpen, setGrepOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpDialog, setHelpDialog] = useState<"about" | "shortcuts" | null>(null);
  const [streamOpen, setStreamOpen] = useState(false);
  const [aiFloatingMarkerEnabled, setAiFloatingMarkerEnabled] = useState(() => {
    try {
      return localStorage.getItem(AI_FLOATING_MARKER_KEY) !== "false";
    } catch {
      return true;
    }
  });
  const [aiPanelWidth, setAiPanelWidth] = useState(() => {
    try {
      const stored = localStorage.getItem(AI_PANEL_WIDTH_KEY);
      return stored === null ? AI_PANEL_DEFAULT_WIDTH : clampAiPanelWidth(Number(stored));
    } catch {
      return AI_PANEL_DEFAULT_WIDTH;
    }
  });
  const markdown = Boolean(active?.mode === "text" && isMarkdownFile(active.name));
  const previewOn = Boolean(active?.mode === "text" && active.preview);
  const showSource = markdown ? Boolean(active?.source) : true;
  const showPreview = markdown || previewOn;
  const { t } = useI18n();

  const togglePreview = useCallback(() => {
    const tab = selectActiveTab(useWorkspace.getState());
    if (!tab || tab.mode !== "text") return;
    if (isMarkdownFile(tab.name)) {
      const shown = !tab.source;
      useWorkspace.getState().setSource(tab.id, shown);
      rememberMarkdownSource(shown);
    } else useWorkspace.getState().setPreview(tab.id, !tab.preview);
  }, []);

  // Draggable editor/preview split (mouse drag or arrow keys on the separator).
  const [splitPercent, setSplitPercent] = useState(() => {
    try {
      const stored = localStorage.getItem(SPLIT_KEY);
      return stored === null ? DEFAULT_SPLIT_PERCENT : normalizeSplitPercent(Number(stored));
    } catch {
      return DEFAULT_SPLIT_PERCENT;
    }
  });
  const splitRef = useRef<HTMLDivElement | null>(null);
  const splitDragging = useRef(false);

  useEffect(() => {
    try {
      localStorage.setItem(SPLIT_KEY, String(splitPercent));
    } catch {
      /* ignore storage errors */
    }
  }, [splitPercent]);

  useEffect(() => {
    try {
      localStorage.setItem(AI_PANEL_WIDTH_KEY, String(aiPanelWidth));
    } catch {
      /* ignore storage errors */
    }
  }, [aiPanelWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(AI_FLOATING_MARKER_KEY, String(aiFloatingMarkerEnabled));
    } catch {
      /* ignore storage errors */
    }
  }, [aiFloatingMarkerEnabled]);

  const startSplitDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const container = splitRef.current;
    if (!container || event.button !== 0) return;
    event.preventDefault();

    const rect = container.getBoundingClientRect();
    splitDragging.current = true;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (moveEvent: PointerEvent) => {
      if (!splitDragging.current) return;
      setSplitPercent(clampSplitPercent(moveEvent.clientX, rect.left, rect.width));
    };
    const onUp = () => {
      splitDragging.current = false;
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, []);

  // Success banners are transient; errors stay until dismissed.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => useWorkspace.getState().setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const dragging = useWorkspace((s) => s.dragging);
  const error = useWorkspace((s) => s.error);

  const openPaths = useCallback(
    async (paths: string[], fromSession = false): Promise<OpenFailure[]> => {
      const store = useWorkspace.getState();
      const failures: OpenFailure[] = [];

      for (const path of paths) {
        const existing = store.tabs.find((t) => t.path && samePath(t.path, path));
        if (existing) {
          store.setActive(existing.id);
          continue;
        }
        try {
          const document = await openDocument(path);
          store.addTab(
            document.mode === "large" ? tabFromLarge(document.info) : tabFromFile(document.file)
          );
        } catch (e) {
          failures.push({ path, reason: friendlyReason(e) });
        }
      }

      if (failures.length > 0) {
        const detail = failures
          .slice(0, 3)
          .map((failure) => `• ${failure.path}\n  ${failure.reason}`)
          .join("\n");
        const more =
          failures.length > 3 ? `\n${tr("app.failures.more", { count: failures.length })}` : "";
        const intro = fromSession
          ? tr("app.failures.session", { count: failures.length })
          : tr("app.failures.open", { count: failures.length });
        store.setError(tr("app.failures.body", { intro, detail, more }));
      }

      return failures;
    },
    []
  );

  const openViaDialog = useCallback(async () => {
    try {
      const paths = await pickOpenPaths();
      if (paths.length > 0) await openPaths(paths);
    } catch (e) {
      useWorkspace.getState().setError(localizeError(e));
    }
  }, [openPaths]);

  const openFolder = useCallback(async () => {
    try {
      const directory = await pickDirectory();
      if (!directory) return;
      await useFileTree.getState().openRoot(directory);
    } catch (e) {
      useWorkspace.getState().setError(localizeError(e));
    }
  }, []);

  /** Status bar / title bar / Ctrl+Shift+E all toggle the same panel. */
  const toggleTree = useCallback(() => {
    const tree = useFileTree.getState();
    if (!tree.rootPath) {
      void openFolder();
      return;
    }
    if (tree.hidden) {
      tree.setHidden(false);
      tree.requestFocus();
    } else {
      tree.setHidden(true);
      document.querySelector<HTMLElement>(".cm-content")?.focus();
    }
  }, [openFolder]);

  const openRecent = useCallback(
    (path: string) => {
      void openPaths([path]);
    },
    [openPaths]
  );

  const createWindow = useCallback(async () => {
    try {
      await openNewWindow();
    } catch (e) {
      useWorkspace.getState().setError(localizeError(e));
    }
  }, []);

  /** Open a grep hit: focus its tab (opening the file if needed) and reveal the line. */
  const openMatch = useCallback(
    async (path: string, line: number) => {
      const store = useWorkspace.getState();
      let tab = store.tabs.find((t) => t.path === path);
      if (!tab) {
        await openPaths([path]);
        tab = useWorkspace.getState().tabs.find((t) => t.path === path);
      }
      if (!tab) return;
      useWorkspace.getState().setActive(tab.id);
      if (tab.mode === "large") {
        useWorkspace.getState().setError(tr("app.large.jump"));
        return;
      }
      revealLineWhenReady(tab.id, line, () => setGrepOpen(false));
    },
    [openPaths]
  );

  /** Save a pasted image next to the document and return the Markdown snippet. */
  const handlePasteImage = useCallback(async (file: File): Promise<string | null> => {
    const store = useWorkspace.getState();
    const tab = store.tabs.find((t) => t.id === store.activeId);
    if (!tab?.path || tab.mode !== "text") {
      store.setError(tr("app.paste.needPath"));
      return null;
    }

    const separator = Math.max(tab.path.lastIndexOf("/"), tab.path.lastIndexOf("\\"));
    if (separator <= 0) {
      store.setError(tr("app.paste.noDir"));
      return null;
    }
    const dir = tab.path.slice(0, separator);
    const extension =
      file.type === "image/jpeg"
        ? "jpg"
        : file.type === "image/gif"
          ? "gif"
          : file.type === "image/webp"
            ? "webp"
            : "png";
    const filename = `image-${Date.now()}.${extension}`;

    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const relative = await saveAsset(dir, filename, bytes);
      store.setNotice(tr("app.paste.saved", { path: relative }));
      return `![${tr("app.paste.alt")}](${relative})`;
    } catch (e) {
      store.setError(localizeError(e));
      return null;
    }
  }, []);

  /** Export the active buffer as a self-contained HTML file (T19). */ const exportActiveAsHtml =
    useCallback(async () => {
      const store = useWorkspace.getState();
      const tab = store.tabs.find((t) => t.id === store.activeId);
      if (!tab || tab.mode !== "text") return;

      const content = readBuffer(tab.id, tab.content);
      const title = tab.name.replace(/\.(md|markdown|mdx)$/i, "") || tr("app.export.untitled");
      const separator = tab.path
        ? Math.max(tab.path.lastIndexOf("/"), tab.path.lastIndexOf("\\"))
        : -1;
      const baseDir = separator > 0 && tab.path ? tab.path.slice(0, separator) : undefined;
      try {
        const target = tab.path
          ? htmlPathFor(tab.path)
          : await pickSavePath(`${title.replace(/[\\/:*?"<>|]/g, "-")}.html`);
        if (!target) return;
        const html = await buildHtmlDocument(title, content, {
          baseDir,
          theme: getResolvedTheme(),
        });
        const portable = await inlineLocalImages(html, loadImageDataUrl);
        await writeFile(target, portable, { ...DEFAULT_META });
        store.setNotice(tr("app.export.done", { path: target }));
      } catch (e) {
        store.setError(localizeError(e));
      }
    }, []);

  /** Reload a tab from disk, respecting the text / large-file split. */
  const reloadFromDisk = useCallback(async (tabId: string) => {
    const store = useWorkspace.getState();
    const tab = store.tabs.find((t) => t.id === tabId);
    if (!tab?.path) return;
    try {
      const document = await openDocument(tab.path);
      if (document.mode === "large") store.reloadLargeTab(tabId, document.info);
      else store.reloadTab(tabId, document.file);
    } catch (e) {
      store.setError(localizeError(e));
    }
  }, []);

  const saveTab = useCallback(
    async (tabId: string, saveAs = false): Promise<boolean> => {
      const store = useWorkspace.getState();
      const tab = store.tabs.find((t) => t.id === tabId);
      if (!tab) return true;

      if (tab.mode === "large") {
        store.setError(tr("app.large.save"));
        return false;
      }

      // A proposal is not part of the buffer. Drop it before reading so a
      // save during the stream cannot be followed by accepting that reply.
      dismissRewriteForSave(tabId);
      const content = readBuffer(tabId, tab.content);

      let path = tab.path;
      if (!path || saveAs) {
        const suggested = /\.\w+$/.test(tab.name) ? tab.name : `${tab.name}.md`;
        try {
          path = await pickSavePath(suggested);
        } catch (e) {
          store.setError(localizeError(e));
          return false;
        }
        if (!path) return false;
      }

      // Saving as onto a path that another tab already owns would create a
      // duplicate tab; switch to that tab instead (T30).
      if (path !== tab.path) {
        const duplicate = duplicateTab(store.tabs, tab.id, path);
        if (duplicate) {
          store.setError(tr("app.duplicate", { name: duplicate.name }));
          store.setActive(duplicate.id);
          return false;
        }
      }
      // Never silently overwrite edits made outside the app.
      if (tab.path && !saveAs) {
        try {
          const disk = await statFile(path);
          if (statConflicts(tab, disk)) {
            const choice = await ask({
              title: tr("dialog.external.title"),
              message: tr("dialog.external.message", {
                name: tab.name,
                diskSize: formatSize(disk.size),
                diskTime: formatTime(disk.mtimeMs),
                openSize: formatSize(tab.size),
                openTime: formatTime(tab.mtimeMs),
              }),
              buttons: [
                { label: tr("dialog.cancel"), value: "cancel" },
                { label: tr("dialog.reload"), value: "reload", variant: "ghost" },
                { label: tr("dialog.overwrite"), value: "overwrite", variant: "danger" },
              ],
            });
            if (choice === "reload") {
              await reloadFromDisk(tab.id);
              return false;
            }
            if (choice !== "overwrite") return false;
          }
        } catch {
          // File may be gone; let the write itself surface the error.
        }
      }

      // A lossily decoded buffer must never overwrite the original bytes silently.
      if (tab.meta.lossy) {
        const choice = await ask({
          title: tr("dialog.lossy.title"),
          message: tr("dialog.lossy.message", { name: tab.name }),
          buttons: [
            { label: tr("dialog.cancel"), value: "cancel" },
            { label: tr("dialog.lossy.save"), value: "save", variant: "danger" },
          ],
        });
        if (choice !== "save") return false;
      }

      // Mixed line endings get normalized to the dominant flavour on save.
      if (tab.meta.mixedEol) {
        const target = EOL_LABEL[tab.meta.eol] ?? tab.meta.eol.toUpperCase();
        const choice = await ask({
          title: tr("dialog.mixed.title"),
          message: tr("dialog.mixed.message", { name: tab.name, eol: target }),
          buttons: [
            { label: tr("dialog.cancel"), value: "cancel" },
            { label: tr("dialog.mixed.save", { eol: target }), value: "save", variant: "primary" },
          ],
        });
        if (choice !== "save") return false;
      }

      const meta = tab.meta.lossy ? { ...tab.meta, lossy: false } : tab.meta;
      try {
        const result = await writeFile(path, content, meta, tab.meta.lossy);
        store.markSaved(tab.id, {
          path,
          content,
          meta: result.meta,
          size: result.size,
          mtimeMs: result.mtimeMs,
        });
        return true;
      } catch (e) {
        store.setError(localizeError(e));
        return false;
      }
    },
    [reloadFromDisk]
  );

  const saveAll = useCallback(async () => {
    const tabs = useWorkspace.getState().tabs.filter((tab) => tab.mode === "text" && tab.dirty);
    for (const tab of tabs) {
      const saved = await saveTab(tab.id);
      if (!saved) return;
    }
  }, [saveTab]);

  /**
   * Rename a file on disk and point any open tab at the new path.
   * An unsaved tab only changes its display name; the real rename happens on save.
   */
  const renameExistingFile = useCallback(
    async (path: string, currentName: string, tabId?: string) => {
      const extension = extensionOf(currentName);
      const store = useWorkspace.getState();
      const name = await askName({
        title: tr("tab.rename"),
        label: tr("tab.renameLabel"),
        initial: currentName,
        confirmLabel: tr("tab.rename.confirm"),
        cancelLabel: tr("dialog.cancel"),
        validate: (value) => {
          const next = withExtension(value, extension);
          const folder = parentDir(path);
          const target = folder ? joinPath(folder, next) : next;
          if (samePath(target, path)) return null;
          const clash = duplicateTab(useWorkspace.getState().tabs, tabId ?? "", target);
          return clash ? tr("app.duplicate", { name: clash.name }) : null;
        },
      });
      if (!name) return;

      try {
        const result = await renameFile(path, withExtension(name, extension));
        const open = useWorkspace
          .getState()
          .tabs.find((item) => item.path && samePath(item.path, path));
        if (open) {
          const disk = await statFile(result.path).catch(() => null);
          store.renameTab(open.id, {
            path: result.path,
            name: result.name,
            mtimeMs: disk?.mtimeMs ?? open.mtimeMs,
          });
        }
        store.setNotice(tr("tab.rename.done", { name: result.name }));
        const folder = parentDir(result.path);
        if (folder) void useFileTree.getState().retryDir(folder);
      } catch (e) {
        store.setError(localizeError(e));
      }
    },
    []
  );

  const requestRenameTab = useCallback(
    async (tabId: string) => {
      const store = useWorkspace.getState();
      const tab = store.tabs.find((item) => item.id === tabId);
      if (!tab) return;
      if (!tab.path) {
        const extension = extensionOf(tab.name) || ".md";
        const name = await askName({
          title: tr("tab.rename"),
          label: tr("tab.renameLabel"),
          initial: tab.name,
          confirmLabel: tr("tab.rename.confirm"),
          cancelLabel: tr("dialog.cancel"),
        });
        if (!name) return;
        store.setName(tab.id, withExtension(name, extension));
        return;
      }
      await renameExistingFile(tab.path, tab.name, tab.id);
    },
    [renameExistingFile]
  );

  const requestRenamePath = useCallback(
    async (path: string) => {
      const currentName = path.split(/[\\/]/).pop() || path;
      await renameExistingFile(path, currentName);
    },
    [renameExistingFile]
  );

  const requestCloseTab = useCallback(
    async (tabId: string) => {
      const store = useWorkspace.getState();
      const tab = store.tabs.find((t) => t.id === tabId);
      if (!tab) return;

      if (tab.dirty) {
        const choice = await ask({
          title: tr("dialog.unsaved.title"),
          message: tr("dialog.unsaved.message", { name: tab.name }),
          buttons: [
            { label: tr("dialog.cancel"), value: "cancel" },
            { label: tr("dialog.discard"), value: "discard", variant: "ghost" },
            { label: tr("dialog.save"), value: "save", variant: "primary" },
          ],
        });
        if (choice === null || choice === "cancel") return;
        if (choice === "save" && !(await saveTab(tab.id))) return;
      }

      store.closeTab(tabId);
    },
    [saveTab]
  );

  const requestCloseAll = useCallback(async (): Promise<boolean> => {
    const store = useWorkspace.getState();
    for (const tab of [...store.tabs]) {
      if (!tab.dirty) continue;
      const choice = await ask({
        title: tr("dialog.closeAll.title"),
        message: tr("dialog.unsaved.message", { name: tab.name }),
        buttons: [
          { label: tr("dialog.cancel"), value: "cancel" },
          { label: tr("dialog.discard"), value: "discard", variant: "ghost" },
          { label: tr("dialog.save"), value: "save", variant: "primary" },
        ],
      });
      if (choice === null || choice === "cancel") return false;
      if (choice === "save" && !(await saveTab(tab.id))) return false;
    }
    return true;
  }, [saveTab]);

  // External changes: silent reload when clean, three-way prompt when dirty.
  const handleExternalChange = useCallback(
    async (event: FileChangeEvent) => {
      const store = useWorkspace.getState();
      const tab = store.tabs.find((t) => t.path === event.path);
      if (!tab) return;

      // Our own saves echo back through the watcher; the store already has the stat.
      if (isWatcherEcho(tab, event)) return;
      if (event.size === 0 && event.mtimeMs === 0) {
        store.setError(tr("app.deleted", { name: tab.name }));
        return;
      }

      if (!tab.dirty) {
        await reloadFromDisk(tab.id);
        return;
      }

      const choice = await ask({
        title: tr("dialog.external.title"),
        message: tr("dialog.conflict.message", {
          name: tab.name,
          diskSize: formatSize(event.size),
          diskTime: formatTime(event.mtimeMs),
        }),
        buttons: [
          { label: tr("dialog.keepMine"), value: "keep", variant: "primary" },
          { label: tr("dialog.reload"), value: "reload", variant: "ghost" },
          { label: tr("dialog.later"), value: "later" },
        ],
      });
      if (choice === "reload") await reloadFromDisk(tab.id);
    },
    [reloadFromDisk]
  );

  useFileWatch(handleExternalChange);

  // Restore recent files + last session.
  useEffect(() => {
    const store = useWorkspace.getState();
    try {
      const rawRecent = localStorage.getItem(RECENT_KEY);
      if (rawRecent) store.setRecent(JSON.parse(rawRecent) as string[]);
    } catch {
      /* ignore malformed storage */
    }

    if (!isTauri || !currentWindowOwnsSession()) return;
    void useFileTree.getState().restore();
    try {
      const rawSession = localStorage.getItem(SESSION_KEY);
      if (!rawSession) return;
      const paths = JSON.parse(rawSession) as string[];
      if (!Array.isArray(paths) || paths.length === 0) return;

      void (async () => {
        const failures = await openPaths(paths, true);
        // Drop files that no longer exist so the next launch doesn't retry them.
        const restored = paths.filter((path) => !failures.some((f) => f.path === path));
        localStorage.setItem(SESSION_KEY, JSON.stringify(restored));
      })();
    } catch {
      /* ignore malformed storage */
    }
  }, [openPaths]);

  // Persist the open file list (paths only), debounced so typing never hits storage.
  // Extra windows stay out of this list so they cannot replace the main window's files.
  useEffect(() => {
    if (!currentWindowOwnsSession()) return;
    let timer: number | undefined;
    const unsubscribe = useWorkspace.subscribe(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const paths = useWorkspace
          .getState()
          .tabs.map((t) => t.path)
          .filter((p): p is string => Boolean(p));
        localStorage.setItem(SESSION_KEY, JSON.stringify(paths));
      }, SESSION_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, []);

  // Persist recent files only when they actually change.
  useEffect(() => {
    const unsubscribe = useWorkspace.subscribe((state, previous) => {
      if (state.recent === previous.recent) return;
      localStorage.setItem(RECENT_KEY, JSON.stringify(state.recent));
    });
    return unsubscribe;
  }, []);

  // Forget the cached EditorState of closed tabs (M-06).
  useEffect(() => {
    const unsubscribe = useWorkspace.subscribe((state) => {
      dropDocStatesExcept(new Set(state.tabs.map((tab) => tab.id)));
    });
    return unsubscribe;
  }, []);

  // Native drag & drop (Tauri).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    onFileDrop({
      onOver: () => useWorkspace.getState().setDragging(true),
      onLeave: () => useWorkspace.getState().setDragging(false),
      onDrop: (paths) => {
        useWorkspace.getState().setDragging(false);
        void openPaths(paths);
      },
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* drag & drop unavailable */
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openPaths]);

  // Guard the window close so unsaved buffers are never dropped silently.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    onCloseRequested(requestCloseAll)
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* close interception unavailable */
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [requestCloseAll]);

  // Ctrl+K and the title-bar chip open the same rewrite panel.
  const openRewrite = useCallback(() => {
    const tab = selectActiveTab(useWorkspace.getState());
    if (!tab || tab.mode !== "text") return;
    const settings = activeModel(loadAiSettings());
    if (!settings?.baseUrl.trim() || !settings.model.trim()) {
      useWorkspace.getState().openSettings("models");
      return;
    }
    setStreamOpen(true);
  }, []);

  /** The AI console behaves like the file tree: the status bar owns its visibility. */
  const toggleAiPanel = useCallback(() => {
    const tab = selectActiveTab(useWorkspace.getState());
    if (!tab || tab.mode !== "text") return;
    if (streamOpen) {
      setStreamOpen(false);
      return;
    }
    const settings = activeModel(loadAiSettings());
    if (!settings?.baseUrl.trim() || !settings.model.trim()) {
      useWorkspace.getState().openSettings("models");
      return;
    }
    setStreamOpen(true);
  }, [streamOpen]);

  // Global shortcuts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isAppShortcutBlocked(event)) return;
      if (event.key === "F2" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const tab = selectActiveTab(useWorkspace.getState());
        if (!tab) return;
        event.preventDefault();
        void requestRenameTab(tab.id);
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey) return;
      const key = event.key.toLowerCase();

      if (key === "k" && !event.shiftKey) {
        event.preventDefault();
        openRewrite();
      } else if (key === "p" && !event.shiftKey) {
        event.preventDefault();
        setPaletteOpen(true);
      } else if (key === "s") {
        event.preventDefault();
        const tab = selectActiveTab(useWorkspace.getState());
        if (tab) void saveTab(tab.id, event.shiftKey);
      } else if (key === "e" && event.shiftKey) {
        event.preventDefault();
        toggleTree();
      } else if (key === "f" && event.shiftKey) {
        event.preventDefault();
        setGrepOpen((open) => !open);
      } else if (key === "m" && event.shiftKey) {
        event.preventDefault();
        togglePreview();
      } else if (key === "a" && event.shiftKey) {
        event.preventDefault();
        toggleAiPanel();
      } else if (key === "," && !event.shiftKey) {
        event.preventDefault();
        useWorkspace.getState().openSettings("general");
      } else if (key === "o") {
        event.preventDefault();
        void openViaDialog();
      } else if (key === "n" && event.shiftKey) {
        event.preventDefault();
        void createWindow();
      } else if (key === "n") {
        event.preventDefault();
        useWorkspace.getState().newTab();
      } else if (key === "r" && !event.shiftKey) {
        event.preventDefault();
        const recent = useWorkspace.getState().recent[0];
        if (recent) void openPaths([recent]);
      } else if (key === "w") {
        event.preventDefault();
        const store = useWorkspace.getState();
        if (store.activeId === SETTINGS_TAB_ID) store.closeSettings();
        else if (store.activeId) void requestCloseTab(store.activeId);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    saveTab,
    openViaDialog,
    openPaths,
    createWindow,
    requestCloseTab,
    requestRenameTab,
    togglePreview,
    toggleAiPanel,
    openRewrite,
    openFolder,
    toggleTree,
  ]);

  const treeRoot = useFileTree((state) => state.rootPath);
  const treeHidden = useFileTree((state) => state.hidden);
  const treeWidth = useFileTree((state) => state.width);
  const showTree = Boolean(treeRoot) && !treeHidden;
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const startTreeDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const container = workspaceRef.current;
    if (!container || event.button !== 0) return;
    event.preventDefault();
    const left = container.getBoundingClientRect().left;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (moveEvent: PointerEvent) => {
      useFileTree.getState().setWidth(clampTreeWidth(moveEvent.clientX - left));
    };
    const onUp = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, []);

  const availableAiPanelWidth = useCallback(() => {
    const workspaceWidth = workspaceRef.current?.getBoundingClientRect().width;
    if (!workspaceWidth) return Number.POSITIVE_INFINITY;
    return workspaceWidth - (showTree ? treeWidth + 6 : 0);
  }, [showTree, treeWidth]);

  const startAiPanelDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const container = workspaceRef.current;
      if (!container || event.button !== 0) return;
      event.preventDefault();

      const rect = container.getBoundingClientRect();
      const previousCursor = document.body.style.cursor;
      const previousSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (moveEvent: PointerEvent) => {
        setAiPanelWidth(clampAiPanelWidth(rect.right - moveEvent.clientX, availableAiPanelWidth()));
      };
      const onUp = () => {
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousSelect;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [availableAiPanelWidth]
  );

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;

    const fitPanel = () => {
      setAiPanelWidth((current) => {
        const next = clampAiPanelWidth(current, availableAiPanelWidth());
        return next === current ? current : next;
      });
    };
    fitPanel();
    const observer = new ResizeObserver(fitPanel);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [availableAiPanelWidth]);

  // Grep prefers the workspace root. Image paths still use the file's own folder.
  const lastSeparator = active?.path
    ? Math.max(active.path.lastIndexOf("/"), active.path.lastIndexOf("\\"))
    : -1;
  const fileDir = active?.path && lastSeparator > 0 ? active.path.slice(0, lastSeparator) : null;
  const grepRoot = grepDefaultRoot(treeRoot, fileDir);

  return (
    <div className="app">
      <MenuBar
        onNew={() => useWorkspace.getState().newTab()}
        onNewWindow={() => void createWindow()}
        onOpenFile={() => void openViaDialog()}
        onOpenFolder={() => void openFolder()}
        onGoToFile={() => setPaletteOpen(true)}
        onCloseFolder={() => useFileTree.getState().closeRoot()}
        hasWorkspace={Boolean(treeRoot)}
        treeHidden={treeHidden}
        onToggleTree={toggleTree}
        onOpenPath={openRecent}
        onSave={() => {
          const tab = selectActiveTab(useWorkspace.getState());
          if (tab) void saveTab(tab.id);
        }}
        onSaveAs={() => {
          const tab = selectActiveTab(useWorkspace.getState());
          if (tab) void saveTab(tab.id, true);
        }}
        onSaveAll={() => void saveAll()}
        onExportHtml={() => void exportActiveAsHtml()}
        onRename={() => {
          const tab = selectActiveTab(useWorkspace.getState());
          if (tab) void requestRenameTab(tab.id);
        }}
        onOpenModelSettings={() => useWorkspace.getState().openSettings("models")}
        onOpenSettings={() => useWorkspace.getState().openSettings("general")}
        aiPanelOpen={streamOpen}
        onToggleAiPanel={toggleAiPanel}
        onAbout={() => setHelpDialog("about")}
        onShortcuts={() => setHelpDialog("shortcuts")}
        onFeedback={() => {
          openFeedback().catch((e) => useWorkspace.getState().setError(localizeError(e)));
        }}
        canAsk={active?.mode === "text"}
        aiMarkerEnabled={aiFloatingMarkerEnabled}
        onToggleAiMarker={() => setAiFloatingMarkerEnabled((enabled) => !enabled)}
      />
      <div className="workspace" ref={workspaceRef}>
        {showTree && (
          <>
            <FileTree
              width={treeWidth}
              onOpenFile={(path) => void openPaths([path])}
              onRenameFile={(path) => void requestRenamePath(path)}
            />
            <div
              className="split__divider file-tree__divider"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("tree.resize")}
              aria-valuemin={160}
              aria-valuemax={400}
              aria-valuenow={treeWidth}
              tabIndex={0}
              onPointerDown={startTreeDrag}
              onDoubleClick={() => useFileTree.getState().setWidth(240)}
            />
          </>
        )}
        <div className="workspace__main">
          <TabBar
            onClose={(id) => void requestCloseTab(id)}
            onRename={(id) => void requestRenameTab(id)}
          />

          {(error || notice) && (
            <div className={`banner ${notice && !error ? "banner--ok" : ""}`} role="status">
              <span className="banner__text">{error ?? notice}</span>
              <button
                type="button"
                className="banner__close"
                aria-label={t("app.close")}
                onClick={() => {
                  useWorkspace.getState().setError(null);
                  useWorkspace.getState().setNotice(null);
                }}
              >
                ×
              </button>
            </div>
          )}

          <div className="workspace__body">
            {settingsActive ? (
              <SettingsPage />
            ) : active ? (
              active.mode === "large" ? (
                <LargeFileViewer key={`${active.id}:${active.version}`} tab={active} />
              ) : (
                <div className="split" ref={splitRef}>
                  <div
                    className={`split__pane${showSource ? "" : " split__pane--off"}`}
                    style={{ width: showSource && showPreview ? `${splitPercent}%` : "100%" }}
                  >
                    <EditorHost
                      tab={active}
                      simplified={active.size > 5 * 1024 * 1024}
                      onPasteImage={handlePasteImage}
                      visible={showSource}
                    />
                  </div>
                  {showPreview && (
                    <>
                      {showSource && (
                        <div
                          className="split__divider"
                          role="separator"
                          aria-orientation="vertical"
                          aria-label={t("app.split.label")}
                          aria-valuemin={MIN_SPLIT_PERCENT}
                          aria-valuemax={MAX_SPLIT_PERCENT}
                          aria-valuenow={Math.round(splitPercent)}
                          tabIndex={0}
                          title={t("app.split.title")}
                          onPointerDown={startSplitDrag}
                          onDoubleClick={() => setSplitPercent(50)}
                          onKeyDown={(event) => {
                            if (event.key === "ArrowLeft") {
                              event.preventDefault();
                              setSplitPercent((value) =>
                                adjustSplitPercent(value, -SPLIT_KEYBOARD_STEP)
                              );
                            } else if (event.key === "ArrowRight") {
                              event.preventDefault();
                              setSplitPercent((value) =>
                                adjustSplitPercent(value, SPLIT_KEYBOARD_STEP)
                              );
                            }
                          }}
                        />
                      )}
                      <div className="split__pane split__pane--preview">
                        <MarkdownPreview
                          key={active.id}
                          tabId={active.id}
                          name={active.name}
                          baseDir={fileDir}
                          onExport={() => void exportActiveAsHtml()}
                          sourceOn={showSource}
                          onToggleSource={markdown ? togglePreview : undefined}
                          syncScroll={showSource}
                        />
                      </div>
                    </>
                  )}
                </div>
              )
            ) : (
              <Welcome
                onOpen={() => void openViaDialog()}
                onNew={() => useWorkspace.getState().newTab()}
                onOpenFolder={() => void openFolder()}
                onOpenPath={(path) => void openPaths([path])}
              />
            )}
          </div>
        </div>

        {streamOpen && active?.mode === "text" && (
          <>
            <div
              className="split__divider ai-stream__divider"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("ai.stream.resize")}
              aria-valuemin={300}
              aria-valuemax={640}
              aria-valuenow={aiPanelWidth}
              tabIndex={0}
              title={t("ai.stream.resize")}
              onPointerDown={startAiPanelDrag}
              onDoubleClick={() =>
                setAiPanelWidth(clampAiPanelWidth(AI_PANEL_DEFAULT_WIDTH, availableAiPanelWidth()))
              }
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  setAiPanelWidth((width) =>
                    clampAiPanelWidth(width + AI_PANEL_KEYBOARD_STEP, availableAiPanelWidth())
                  );
                } else if (event.key === "ArrowRight") {
                  event.preventDefault();
                  setAiPanelWidth((width) =>
                    clampAiPanelWidth(width - AI_PANEL_KEYBOARD_STEP, availableAiPanelWidth())
                  );
                }
              }}
            />
            <AiStreamPanel
              tabId={active.id}
              panelWidth={aiPanelWidth}
              sourceShown={showSource}
              onClose={() => setStreamOpen(false)}
              onOpenMatch={(path, line) => void openMatch(path, line)}
              onNeedSettings={() => {
                setStreamOpen(false);
                useWorkspace.getState().openSettings("models");
              }}
            />
          </>
        )}
      </div>

      {active?.mode === "text" && (
        <AiSelectionAction
          key={active.id}
          tabId={active.id}
          visible={aiFloatingMarkerEnabled && !streamOpen}
          onRewrite={openRewrite}
        />
      )}

      <StatusBar
        previewOn={markdown ? showSource : previewOn}
        sourceToggle={markdown}
        onTogglePreview={togglePreview}
        canPreview={Boolean(active && active.mode === "text")}
        hasWorkspace={Boolean(treeRoot)}
        treeHidden={treeHidden}
        onToggleTree={toggleTree}
        aiPanelOpen={streamOpen}
        onToggleAiPanel={toggleAiPanel}
      />

      {grepOpen && (
        <GrepPanel
          defaultRoot={grepRoot}
          onClose={() => setGrepOpen(false)}
          onOpenMatch={(path, line) => void openMatch(path, line)}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onOpenFile={(path) => {
            setPaletteOpen(false);
            void openPaths([path]);
          }}
          onCommand={(id) => {
            setPaletteOpen(false);
            if (id === "export-html") void exportActiveAsHtml();
          }}
          onRevealLine={(line) => {
            setPaletteOpen(false);
            if (active) revealLineWhenReady(active.id, line, () => {});
          }}
        />
      )}

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-overlay__box">{t("app.dropOverlay")}</div>
        </div>
      )}

      {helpDialog === "about" && <AboutDialog onClose={() => setHelpDialog(null)} />}
      {helpDialog === "shortcuts" && <ShortcutsDialog onClose={() => setHelpDialog(null)} />}
      <RenameDialog />
      <DialogHost />
    </div>
  );
}
