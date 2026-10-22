import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import CodeEditor from "./editor/CodeEditor";
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
import MenuBar from "./features/MenuBar";
import StatusBar from "./features/StatusBar";
import TabBar from "./features/TabBar";
import Welcome from "./features/Welcome";
import { ask } from "./features/dialogStore";
import DialogHost from "./features/Dialog";
import {
  currentWindowOwnsSession,
  isTauri,
  onCloseRequested,
  onFileChanged,
  onFileDrop,
  openDocument,
  listTextFiles,
  openNewWindow,
  pickDirectory,
  pickOpenPaths,
  pickSavePath,
  saveAsset,
  statFile,
  unwatchFile,
  watchFile,
  writeFile,
} from "./ipc/api";
import { getDocText, revealLine } from "./editor/registry";
import { DEFAULT_META, type FileChangeEvent } from "./ipc/types";
import { localizeError, t as tr, useI18n } from "./i18n";
import { formatSize, formatTime } from "./lib/format";
import { samePath } from "./lib/paths";
import { buildHtmlDocument, htmlPathFor, inlineLocalImages } from "./features/exportHtml";
import { getResolvedTheme } from "./features/theme";
import { loadImageDataUrl } from "./features/images";
import {
  selectActiveTab,
  tabFromFile,
  tabFromLarge,
  useWorkspace,
  type Tab,
} from "./stores/workspace";

const SESSION_KEY = "ainative.session";
const RECENT_KEY = "ainative.recent";
const SPLIT_KEY = "ainative.splitPercent";
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
  const notice = useWorkspace((state) => state.notice);
  const [grepOpen, setGrepOpen] = useState(false);
  const previewOn = Boolean(active?.mode === "text" && active.preview);
  const { t } = useI18n();

  const togglePreview = useCallback(() => {
    const tab = selectActiveTab(useWorkspace.getState());
    if (!tab || tab.mode !== "text") return;
    useWorkspace.getState().setPreview(tab.id, !tab.preview);
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
        const existing = store.tabs.find((t) => t.path === path);
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
    const store = useWorkspace.getState();
    try {
      const directory = await pickDirectory();
      if (!directory) return;
      const files = await listTextFiles(directory);
      if (files.length === 0) {
        store.setNotice(tr("app.folder.empty"));
        return;
      }
      await openPaths(files);
      if (files.length >= 40) store.setNotice(tr("app.folder.limit"));
    } catch (e) {
      useWorkspace.getState().setError(localizeError(e));
    }
  }, [openPaths]);

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

      const tabId = tab.id;
      let attempts = 0;
      const tryReveal = () => {
        if (revealLine(tabId, line)) {
          setGrepOpen(false);
          return;
        }
        attempts += 1;
        if (attempts < 12) window.setTimeout(tryReveal, 50);
      };
      window.setTimeout(tryReveal, 50);
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

      const content = getDocText(tab.id) ?? tab.content;
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
        const html = buildHtmlDocument(title, content, { baseDir, theme: getResolvedTheme() });
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

      // The live buffer wins over the store snapshot when the tab is mounted.
      const content = getDocText(tabId) ?? tab.content;

      let path = tab.path;
      if (!path || saveAs) {
        const suggested = /\.\w+$/.test(tab.name) ? tab.name : `${tab.name}.txt`;
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
        const duplicate = store.tabs.find(
          (candidate) => candidate.id !== tab.id && candidate.path && samePath(candidate.path, path)
        );
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
          if (disk.mtimeMs !== tab.mtimeMs || disk.size !== tab.size) {
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
      if (event.mtimeMs === tab.mtimeMs && (tab.mode === "large" || event.size === tab.size)) {
        return;
      }
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

  // Keep the Rust watcher in sync with the open tabs.
  const watchedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isTauri) return;
    const sync = (tabs: Tab[]) => {
      const next = new Set(
        tabs.map((tab) => tab.path).filter((path): path is string => Boolean(path))
      );
      for (const path of next) {
        if (watchedRef.current.has(path)) continue;
        watchedRef.current.add(path);
        void watchFile(path).catch(() => watchedRef.current.delete(path));
      }
      for (const path of [...watchedRef.current]) {
        if (next.has(path)) continue;
        watchedRef.current.delete(path);
        void unwatchFile(path);
      }
    };

    sync(useWorkspace.getState().tabs);
    const unsubscribe = useWorkspace.subscribe((state, previous) => {
      if (state.tabs !== previous.tabs) sync(state.tabs);
    });
    const watched = watchedRef.current;
    return () => {
      unsubscribe();
      for (const path of watched) void unwatchFile(path);
      watched.clear();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void onFileChanged((event) => {
      void handleExternalChange(event);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [handleExternalChange]);

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

  // Global shortcuts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey) return;
      const key = event.key.toLowerCase();

      if (key === "s") {
        event.preventDefault();
        const tab = selectActiveTab(useWorkspace.getState());
        if (tab) void saveTab(tab.id, event.shiftKey);
      } else if (key === "f" && event.shiftKey) {
        event.preventDefault();
        setGrepOpen((open) => !open);
      } else if (key === "m" && event.shiftKey) {
        event.preventDefault();
        togglePreview();
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
        if (store.activeId) void requestCloseTab(store.activeId);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveTab, openViaDialog, openPaths, createWindow, requestCloseTab, togglePreview]);

  // Default grep root: the directory of the active file.
  const lastSeparator = active?.path
    ? Math.max(active.path.lastIndexOf("/"), active.path.lastIndexOf("\\"))
    : -1;
  const grepRoot = active?.path && lastSeparator > 0 ? active.path.slice(0, lastSeparator) : null;

  return (
    <div className="app">
      <MenuBar
        onNew={() => useWorkspace.getState().newTab()}
        onNewWindow={() => void createWindow()}
        onOpenFile={() => void openViaDialog()}
        onOpenFolder={() => void openFolder()}
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
      />
      <TabBar onClose={(id) => void requestCloseTab(id)} />

      {(error || notice) && (
        <div className={`banner ${notice && !error ? "banner--ok" : ""}`} role="status">
          <span className="banner__text">{error ?? notice}</span>
          <button
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

      <main className="workspace">
        {active ? (
          active.mode === "large" ? (
            <LargeFileViewer key={`${active.id}:${active.version}`} tab={active} />
          ) : previewOn ? (
            <div className="split" ref={splitRef}>
              <div className="split__pane" style={{ width: `${splitPercent}%` }}>
                <CodeEditor
                  key={`${active.id}:${active.version}`}
                  tabId={active.id}
                  content={active.content}
                  filename={active.name}
                  version={active.version}
                  simplified={active.size > 5 * 1024 * 1024}
                  onStats={(id, stats) => useWorkspace.getState().markEdited(id, stats)}
                  onFlush={(id, content, version) =>
                    useWorkspace.getState().setContent(id, content, version)
                  }
                  onPasteImage={handlePasteImage}
                />
              </div>
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
                    setSplitPercent((value) => adjustSplitPercent(value, -SPLIT_KEYBOARD_STEP));
                  } else if (event.key === "ArrowRight") {
                    event.preventDefault();
                    setSplitPercent((value) => adjustSplitPercent(value, SPLIT_KEYBOARD_STEP));
                  }
                }}
              />
              <div className="split__pane split__pane--preview">
                <MarkdownPreview
                  key={active.id}
                  tabId={active.id}
                  name={active.name}
                  baseDir={grepRoot}
                  onExport={() => void exportActiveAsHtml()}
                />
              </div>
            </div>
          ) : (
            <CodeEditor
              key={`${active.id}:${active.version}`}
              tabId={active.id}
              content={active.content}
              filename={active.name}
              version={active.version}
              simplified={active.size > 5 * 1024 * 1024}
              onStats={(id, stats) => useWorkspace.getState().markEdited(id, stats)}
              onFlush={(id, content, version) =>
                useWorkspace.getState().setContent(id, content, version)
              }
              onPasteImage={handlePasteImage}
            />
          )
        ) : (
          <Welcome
            onOpen={() => void openViaDialog()}
            onNew={() => useWorkspace.getState().newTab()}
            onOpenPath={(path) => void openPaths([path])}
          />
        )}
      </main>

      <StatusBar
        previewOn={previewOn}
        onTogglePreview={togglePreview}
        canPreview={Boolean(active && active.mode === "text")}
      />

      {grepOpen && (
        <GrepPanel
          defaultRoot={grepRoot}
          onClose={() => setGrepOpen(false)}
          onOpenMatch={(path, line) => void openMatch(path, line)}
        />
      )}

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-overlay__box">{t("app.dropOverlay")}</div>
        </div>
      )}

      <DialogHost />
    </div>
  );
}
