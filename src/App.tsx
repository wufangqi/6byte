import { useCallback, useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import CodeEditor from "./editor/CodeEditor";
import StatusBar from "./features/StatusBar";
import TabBar from "./features/TabBar";
import Welcome from "./features/Welcome";
import { isTauri, pickOpenPaths, pickSavePath, readFile, writeFile } from "./ipc/api";
import { selectActiveTab, useWorkspace } from "./stores/workspace";

const SESSION_KEY = "ainative.session";
const RECENT_KEY = "ainative.recent";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export default function App() {
  const tabs = useWorkspace((s) => s.tabs);
  const active = useWorkspace(selectActiveTab);
  const dragging = useWorkspace((s) => s.dragging);
  const error = useWorkspace((s) => s.error);

  const openPaths = useCallback(async (paths: string[]) => {
    const store = useWorkspace.getState();
    for (const path of paths) {
      const existing = store.tabs.find((t) => t.path === path);
      if (existing) {
        store.setActive(existing.id);
        continue;
      }
      try {
        const file = await readFile(path);
        store.addTab({
          id: crypto.randomUUID(),
          name: file.name,
          path: file.path,
          content: file.content,
          meta: file.meta,
          size: file.size,
          mtimeMs: file.mtimeMs,
          dirty: false,
        });
      } catch (e) {
        store.setError(errorMessage(e));
      }
    }
  }, []);

  const openViaDialog = useCallback(async () => {
    try {
      const paths = await pickOpenPaths();
      if (paths.length > 0) await openPaths(paths);
    } catch (e) {
      useWorkspace.getState().setError(errorMessage(e));
    }
  }, [openPaths]);

  const saveActive = useCallback(async (saveAs = false) => {
    const store = useWorkspace.getState();
    const tab = selectActiveTab(store);
    if (!tab) return;

    let path = tab.path;
    if (!path || saveAs) {
      const suggested = /\.\w+$/.test(tab.name) ? tab.name : `${tab.name}.txt`;
      try {
        path = await pickSavePath(suggested);
      } catch (e) {
        store.setError(errorMessage(e));
        return;
      }
      if (!path) return;
    }

    try {
      const result = await writeFile(path, tab.content, tab.meta);
      store.markSaved(tab.id, {
        path,
        meta: result.meta,
        size: result.size,
        mtimeMs: result.mtimeMs,
      });
    } catch (e) {
      store.setError(errorMessage(e));
    }
  }, []);

  // Restore recent files + last session.
  useEffect(() => {
    const store = useWorkspace.getState();
    try {
      const rawRecent = localStorage.getItem(RECENT_KEY);
      if (rawRecent) store.setRecent(JSON.parse(rawRecent) as string[]);
    } catch {
      /* ignore malformed storage */
    }

    if (!isTauri) return;
    try {
      const rawSession = localStorage.getItem(SESSION_KEY);
      if (!rawSession) return;
      const paths = JSON.parse(rawSession) as string[];
      if (Array.isArray(paths) && paths.length > 0) void openPaths(paths);
    } catch {
      /* ignore malformed storage */
    }
  }, [openPaths]);

  // Persist the open file list (paths only).
  useEffect(() => {
    const paths = tabs.map((t) => t.path).filter((p): p is string => Boolean(p));
    localStorage.setItem(SESSION_KEY, JSON.stringify(paths));
  }, [tabs]);

  // Persist recent files.
  useEffect(
    () =>
      useWorkspace.subscribe((state) => {
        localStorage.setItem(RECENT_KEY, JSON.stringify(state.recent));
      }),
    []
  );

  // Native drag & drop (Tauri).
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const store = useWorkspace.getState();
        if (event.payload.type === "over") {
          store.setDragging(true);
        } else if (event.payload.type === "drop") {
          store.setDragging(false);
          void openPaths(event.payload.paths);
        } else {
          store.setDragging(false);
        }
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

  // Global shortcuts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey) return;
      const key = event.key.toLowerCase();

      if (key === "s") {
        event.preventDefault();
        void saveActive(event.shiftKey);
      } else if (key === "o") {
        event.preventDefault();
        void openViaDialog();
      } else if (key === "n") {
        event.preventDefault();
        useWorkspace.getState().newTab();
      } else if (key === "w") {
        event.preventDefault();
        const store = useWorkspace.getState();
        if (store.activeId) store.closeTab(store.activeId);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveActive, openViaDialog]);

  return (
    <div className="app">
      <TabBar />

      {error && (
        <div className="banner" role="alert">
          <span className="banner__text">{error}</span>
          <button
            className="banner__close"
            aria-label="关闭"
            onClick={() => useWorkspace.getState().setError(null)}
          >
            ×
          </button>
        </div>
      )}

      <main className="workspace">
        {active ? (
          <CodeEditor
            key={active.id}
            content={active.content}
            filename={active.name}
            onChange={(doc) => useWorkspace.getState().updateContent(active.id, doc)}
          />
        ) : (
          <Welcome
            onOpen={() => void openViaDialog()}
            onNew={() => useWorkspace.getState().newTab()}
            onOpenPath={(path) => void openPaths([path])}
          />
        )}
      </main>

      <StatusBar />

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-overlay__box">松开以打开文件</div>
        </div>
      )}
    </div>
  );
}