import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../ipc/api";
import { selectActiveTab, useWorkspace } from "../stores/workspace";
import { setThemePreference, useThemePreference, type ThemePreference } from "./theme";

interface Props {
  onNew(): void;
  onNewWindow(): void;
  onOpenFile(): void;
  onOpenFolder(): void;
  onOpenPath(path: string): void;
  onSave(): void;
  onSaveAs(): void;
  onSaveAll(): void;
}

const THEMES: { id: ThemePreference; label: string }[] = [
  { id: "light", label: "浅色" },
  { id: "dark", label: "深色" },
  { id: "system", label: "跟随系统" },
];

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

/** Window caption: File and View live on the top row, beside the window buttons. */
export default function MenuBar({
  onNew,
  onNewWindow,
  onOpenFile,
  onOpenFolder,
  onOpenPath,
  onSave,
  onSaveAs,
  onSaveAll,
}: Props) {
  const preference = useThemePreference();
  const active = useWorkspace(selectActiveTab);
  const recent = useWorkspace((state) => state.recent);
  const canSaveAll = useWorkspace((state) =>
    state.tabs.some((tab) => tab.mode === "text" && tab.dirty)
  );
  const [menu, setMenu] = useState<"file" | "view" | null>(null);
  const [recentOpen, setRecentOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canSave = active?.mode === "text";

  useEffect(() => {
    if (!menu) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  useEffect(() => {
    if (!isTauri) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void win
      .isMaximized()
      .then(setMaximized)
      .catch(() => {});
    void win
      .onResized(() => {
        void win
          .isMaximized()
          .then(setMaximized)
          .catch(() => {});
      })
      .then((stop) => {
        unlisten = stop;
      });
    return () => unlisten?.();
  }, []);

  return (
    <div className="titlebar">
      <span className="titlebar__brand" data-tauri-drag-region>
        <Logo />
      </span>
      <div className="titlebar__menus" ref={rootRef}>
        <div className="titlebar__menu">
          <button
            type="button"
            className="titlebar__trigger"
            aria-haspopup="menu"
            aria-expanded={menu === "file"}
            onClick={() => {
              setRecentOpen(false);
              setMenu((value) => (value === "file" ? null : "file"));
            }}
          >
            文件
          </button>
          {menu === "file" && (
            <div className="menu menu--file" role="menu" aria-label="文件">
              <FileItem
                label="新建"
                shortcut="Ctrl+N"
                onClick={onNew}
                close={() => setMenu(null)}
              />
              <FileItem
                label="新建窗口"
                shortcut="Ctrl+Shift+N"
                onClick={onNewWindow}
                close={() => setMenu(null)}
              />
              <div className="menu__sep" />
              <FileItem
                label="打开文件…"
                shortcut="Ctrl+O"
                onClick={onOpenFile}
                close={() => setMenu(null)}
              />
              <FileItem label="打开文件夹…" onClick={onOpenFolder} close={() => setMenu(null)} />
              <div
                className="menu__branch"
                onMouseEnter={() => setRecentOpen(true)}
                onMouseLeave={() => setRecentOpen(false)}
              >
                <button
                  type="button"
                  className="menu__item"
                  aria-haspopup="menu"
                  aria-expanded={recentOpen}
                  onClick={() => setRecentOpen(true)}
                >
                  <span>打开最近</span>
                  <span className="menu__shortcut">Ctrl+R</span>
                </button>
                {recentOpen && (
                  <div className="menu menu--sub" role="menu" aria-label="最近打开">
                    {recent.length === 0 ? (
                      <div className="menu__label">没有最近打开的文件</div>
                    ) : (
                      recent.slice(0, 8).map((path) => (
                        <button
                          key={path}
                          type="button"
                          className="menu__item"
                          title={path}
                          onClick={() => {
                            onOpenPath(path);
                            setMenu(null);
                          }}
                        >
                          <span className="menu__label-text">{fileName(path)}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
              <div className="menu__sep" />
              <FileItem
                label="保存"
                shortcut="Ctrl+S"
                disabled={!canSave}
                onClick={onSave}
                close={() => setMenu(null)}
              />
              <FileItem
                label="另存为…"
                shortcut="Ctrl+Shift+S"
                disabled={!canSave}
                onClick={onSaveAs}
                close={() => setMenu(null)}
              />
              <FileItem
                label="全部保存"
                disabled={!canSaveAll}
                onClick={onSaveAll}
                close={() => setMenu(null)}
              />
            </div>
          )}
        </div>
        <div className="titlebar__menu">
          <button
            type="button"
            className="titlebar__trigger"
            aria-haspopup="menu"
            aria-expanded={menu === "view"}
            onClick={() => setMenu((value) => (value === "view" ? null : "view"))}
          >
            视图
          </button>
          {menu === "view" && (
            <div className="menu" role="menu" aria-label="视图">
              <div className="menu__label">主题</div>
              {THEMES.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={theme.id === preference}
                  className="menu__item"
                  onClick={() => {
                    setThemePreference(theme.id);
                    setMenu(null);
                  }}
                >
                  <span className="menu__check" aria-hidden="true">
                    {theme.id === preference ? "✓" : ""}
                  </span>
                  {theme.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="titlebar__drag" data-tauri-drag-region />
      {isTauri && (
        <div className="titlebar__controls">
          <button
            type="button"
            className="titlebar__control"
            aria-label="最小化"
            onClick={() => void getCurrentWindow().minimize()}
          >
            <WindowIcon kind="minimize" />
          </button>
          <button
            type="button"
            className="titlebar__control"
            aria-label={maximized ? "还原" : "最大化"}
            onClick={() => {
              void getCurrentWindow().toggleMaximize();
              setMaximized((value) => !value);
            }}
          >
            <WindowIcon kind={maximized ? "restore" : "maximize"} />
          </button>
          <button
            type="button"
            className="titlebar__control titlebar__control--close"
            aria-label="关闭"
            onClick={() => void getCurrentWindow().close()}
          >
            <WindowIcon kind="close" />
          </button>
        </div>
      )}
    </div>
  );
}

/** Same mark as the app icon: text lines and a caret on a rounded gradient. */
function Logo() {
  return (
    <svg className="titlebar__logo" viewBox="0 0 32 32" role="img" aria-label="6byte">
      <defs>
        <linearGradient id="titlebar-logo" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1e2438" />
          <stop offset="1" stopColor="#483a8a" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7" fill="url(#titlebar-logo)" />
      <rect x="5.8" y="10.9" width="14.1" height="1.8" rx="0.9" fill="#ffffff" opacity="0.91" />
      <rect x="5.8" y="15" width="12.8" height="1.8" rx="0.9" fill="#ffffff" opacity="0.91" />
      <rect x="5.8" y="19.2" width="10.2" height="1.8" rx="0.9" fill="#ffffff" opacity="0.91" />
      <rect x="21.8" y="9.6" width="1.8" height="12.8" rx="0.9" fill="#7aa2f7" />
    </svg>
  );
}

function FileItem({
  label,
  shortcut,
  disabled,
  onClick,
  close,
}: {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick(): void;
  close(): void;
}) {
  return (
    <button
      type="button"
      className="menu__item"
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        onClick();
        close();
      }}
    >
      <span>{label}</span>
      {shortcut && <span className="menu__shortcut">{shortcut}</span>}
    </button>
  );
}

function WindowIcon({ kind }: { kind: "minimize" | "maximize" | "restore" | "close" }) {
  if (kind === "minimize") {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M1 5.5h8" stroke="currentColor" strokeWidth="1" />
      </svg>
    );
  }
  if (kind === "maximize") {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1" />
      </svg>
    );
  }
  if (kind === "restore") {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M3 1.5h5.5V7M1.5 3H7v5.5H1.5z" fill="none" stroke="currentColor" strokeWidth="1" />
      </svg>
    );
  }
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
