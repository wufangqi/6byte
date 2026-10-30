import { useEffect, useId, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { dismissActiveCompletion } from "../editor/completion";
import { useI18n } from "../i18n";
import { isTauri } from "../ipc/api";
import { fileName } from "../lib/paths";
import { selectActiveTab, useWorkspace } from "../stores/workspace";
import { loadAiSettings } from "./aiSettings";
import {
  completionEndpoint,
  loadCompletionSettings,
  saveCompletionSettings,
  subscribeCompletion,
} from "./completionSettings";

interface Props {
  onNew(): void;
  onNewWindow(): void;
  onOpenFile(): void;
  onOpenFolder(): void;
  onGoToFile(): void;
  onCloseFolder(): void;
  hasWorkspace: boolean;
  treeHidden: boolean;
  onToggleTree(): void;
  onOpenPath(path: string): void;
  onSave(): void;
  onSaveAs(): void;
  onSaveAll(): void;
  onExportHtml(): void;
  onRename(): void;
  onOpenModelSettings(): void;
  onOpenSettings(): void;
  aiPanelOpen: boolean;
  onToggleAiPanel(): void;
  onAbout(): void;
  onShortcuts(): void;
  onFeedback(): void;
  canAsk?: boolean;
  aiMarkerEnabled?: boolean;
  onToggleAiMarker?: () => void;
}

/** Window caption: File, View and Help on the left. Model controls sit at the top-right. */
export default function MenuBar({
  onNew,
  onNewWindow,
  onOpenFile,
  onOpenFolder,
  onGoToFile,
  onCloseFolder,
  hasWorkspace,
  treeHidden,
  onToggleTree,
  onOpenPath,
  onSave,
  onSaveAs,
  onSaveAll,
  onExportHtml,
  onRename,
  onOpenModelSettings,
  onOpenSettings,
  aiPanelOpen,
  onToggleAiPanel,
  onAbout,
  onShortcuts,
  onFeedback,
  canAsk = false,
  aiMarkerEnabled = true,
  onToggleAiMarker,
}: Props) {
  const active = useWorkspace(selectActiveTab);
  const recent = useWorkspace((state) => state.recent);
  const canSaveAll = useWorkspace((state) =>
    state.tabs.some((tab) => tab.mode === "text" && tab.dirty)
  );
  const [menu, setMenu] = useState<"file" | "view" | "help" | null>(null);
  const [recentOpen, setRecentOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canSave = active?.mode === "text";
  const { t } = useI18n();
  const [completion, setCompletion] = useState(loadCompletionSettings);
  useEffect(() => subscribeCompletion(() => setCompletion(loadCompletionSettings())), []);

  const toggleCompletion = () => {
    const current = loadCompletionSettings();
    if (!current.enabled && !completionEndpoint(loadAiSettings(), current)) {
      onOpenModelSettings();
      return;
    }
    const next = { ...current, enabled: !current.enabled };
    saveCompletionSettings(next);
    if (!next.enabled) dismissActiveCompletion();
  };

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
      <button
        type="button"
        className="titlebar__brand"
        aria-label={t("menu.about")}
        title={t("menu.about")}
        onClick={() => {
          setMenu(null);
          onAbout();
        }}
      >
        <AppLogo className="titlebar__logo" />
      </button>
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
            {t("menu.file")}
          </button>
          {menu === "file" && (
            <div className="menu menu--file" role="menu" aria-label={t("menu.file")}>
              <FileItem
                label={t("menu.new")}
                shortcut="Ctrl+N"
                onClick={onNew}
                close={() => setMenu(null)}
              />
              <FileItem
                label={t("menu.newWindow")}
                shortcut="Ctrl+Shift+N"
                onClick={onNewWindow}
                close={() => setMenu(null)}
              />
              <div className="menu__sep" />
              <FileItem
                label={t("menu.openFile")}
                shortcut="Ctrl+O"
                onClick={onOpenFile}
                close={() => setMenu(null)}
              />
              <FileItem
                label={t("menu.openFolder")}
                onClick={onOpenFolder}
                close={() => setMenu(null)}
              />
              <FileItem
                label={t("menu.goTo")}
                shortcut="Ctrl+P"
                onClick={onGoToFile}
                close={() => setMenu(null)}
              />
              <FileItem
                label={t("menu.closeFolder")}
                disabled={!hasWorkspace}
                onClick={onCloseFolder}
                close={() => setMenu(null)}
              />
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
                  <span>{t("menu.openRecent")}</span>
                  <span className="menu__shortcut">Ctrl+R</span>
                </button>
                {recentOpen && (
                  <div className="menu menu--sub" role="menu" aria-label={t("menu.recent")}>
                    {recent.length === 0 ? (
                      <div className="menu__label">{t("menu.recentEmpty")}</div>
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
                label={t("menu.save")}
                shortcut="Ctrl+S"
                disabled={!canSave}
                onClick={onSave}
                close={() => setMenu(null)}
              />
              <FileItem
                label={t("menu.saveAs")}
                shortcut="Ctrl+Shift+S"
                disabled={!canSave}
                onClick={onSaveAs}
                close={() => setMenu(null)}
              />
              <FileItem
                label={t("menu.saveAll")}
                disabled={!canSaveAll}
                onClick={onSaveAll}
                close={() => setMenu(null)}
              />
              <FileItem
                label={t("menu.exportHtml")}
                disabled={!canSave}
                onClick={onExportHtml}
                close={() => setMenu(null)}
              />
              <FileItem
                label={t("tab.rename")}
                shortcut="F2"
                disabled={!active}
                onClick={onRename}
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
            {t("menu.view")}
          </button>
          {menu === "view" && (
            <div className="menu" role="menu" aria-label={t("menu.view")}>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={hasWorkspace && !treeHidden}
                className="menu__item"
                onClick={() => {
                  onToggleTree();
                  setMenu(null);
                }}
              >
                <span className="menu__check" aria-hidden="true">
                  {hasWorkspace && !treeHidden ? "✓" : ""}
                </span>
                {t("menu.fileTree")}
                <span className="menu__shortcut">Ctrl+Shift+E</span>
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={aiPanelOpen}
                className="menu__item"
                disabled={!canAsk}
                onClick={() => {
                  onToggleAiPanel();
                  setMenu(null);
                }}
              >
                <span className="menu__check" aria-hidden="true">
                  {aiPanelOpen ? "✓" : ""}
                </span>
                {t("menu.aiPanel")}
                <span className="menu__shortcut">Ctrl+Shift+A</span>
              </button>
            </div>
          )}
        </div>
        <div className="titlebar__menu">
          <button
            type="button"
            className="titlebar__trigger"
            aria-haspopup="menu"
            aria-expanded={menu === "help"}
            onClick={() => setMenu((value) => (value === "help" ? null : "help"))}
          >
            {t("menu.help")}
          </button>
          {menu === "help" && (
            <div className="menu" role="menu" aria-label={t("menu.help")}>
              <FileItem
                label={t("menu.settings")}
                shortcut="Ctrl+,"
                onClick={onOpenSettings}
                close={() => setMenu(null)}
              />
              <div className="menu__sep" />
              <FileItem
                label={t("menu.shortcuts")}
                onClick={onShortcuts}
                close={() => setMenu(null)}
              />
              <FileItem
                label={t("menu.feedback")}
                onClick={onFeedback}
                close={() => setMenu(null)}
              />
              <div className="menu__sep" />
              <FileItem label={t("menu.about")} onClick={onAbout} close={() => setMenu(null)} />
            </div>
          )}
        </div>
      </div>
      <div className="titlebar__drag" data-tauri-drag-region />
      <div className="titlebar__actions">
        {canAsk && (
          <button
            type="button"
            className={`titlebar__icon${completion.enabled ? " titlebar__icon--on" : ""}`}
            aria-label={t("status.complete")}
            data-tip={t(completion.enabled ? "status.complete.on" : "status.complete.off")}
            aria-pressed={completion.enabled}
            onClick={() => {
              setMenu(null);
              toggleCompletion();
            }}
          >
            <ActionIcon kind="complete" />
          </button>
        )}
        {canAsk && onToggleAiMarker && (
          <button
            type="button"
            className={`titlebar__icon${aiMarkerEnabled ? " titlebar__icon--on" : ""}`}
            aria-label={t("status.aiMarker")}
            data-tip={t(aiMarkerEnabled ? "status.aiMarker.on" : "status.aiMarker.off")}
            aria-pressed={aiMarkerEnabled}
            onClick={() => {
              setMenu(null);
              onToggleAiMarker();
            }}
          >
            <ActionIcon kind="marker" />
          </button>
        )}
        {canAsk && <span className="titlebar__sep" aria-hidden="true" />}
        <button
          type="button"
          className="titlebar__icon"
          aria-label={t("menu.model")}
          data-tip={t("menu.model")}
          onClick={() => {
            setRecentOpen(false);
            setMenu(null);
            onOpenModelSettings();
          }}
        >
          <ActionIcon kind="model" />
        </button>
      </div>
      {isTauri && (
        <div className="titlebar__controls">
          <button
            type="button"
            className="titlebar__control"
            aria-label={t("menu.minimize")}
            onClick={() => void getCurrentWindow().minimize()}
          >
            <WindowIcon kind="minimize" />
          </button>
          <button
            type="button"
            className="titlebar__control"
            aria-label={maximized ? t("menu.restore") : t("menu.maximize")}
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
            aria-label={t("menu.close")}
            onClick={() => void getCurrentWindow().close()}
          >
            <WindowIcon kind="close" />
          </button>
        </div>
      )}
    </div>
  );
}

/** Same mark as the app icon: six blocks on the night gradient. The top block is the caret, turned 45° about its lower-right corner. */
export function AppLogo({ className }: { className?: string }) {
  const gradient = useId();
  return (
    <svg className={className} viewBox="0 0 32 32" role="img" aria-label="6byte">
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1e2438" />
          <stop offset="1" stopColor="#483a8a" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7" fill={`url(#${gradient})`} />
      <g fill="#3BE3EE">
        <rect x="7.057" y="10.187" width="5.962" height="5.867" rx="0.95" />
        <rect x="19.035" y="10.187" width="5.908" height="5.867" rx="0.95" />
        <rect x="13.073" y="16.107" width="5.908" height="5.867" rx="0.95" />
        <rect x="7.057" y="22.08" width="5.962" height="5.813" rx="0.95" />
        <rect x="19.035" y="22.08" width="5.908" height="5.813" rx="0.95" />
      </g>
      <rect
        x="7.057"
        y="4.107"
        width="5.962"
        height="5.813"
        rx="0.95"
        fill="#7aa2f7"
        transform="rotate(45 13.019 9.920)"
      />
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

export function ActionIcon({
  kind,
  size = 16,
}: {
  kind: "complete" | "marker" | "model";
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "complete" && (
        <>
          <path d="M2.5 4.5h11M2.5 8h5M9.5 8h1M12 8h1.5M2.5 11.5h7" />
          <path d="M8.3 6.5v3" strokeWidth="1.5" />
        </>
      )}
      {kind === "marker" && (
        <>
          <path d="M3 2.5h10a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1H7.5l-3 2.5V11H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z" />
          <path
            d="M8 4.6l.6 1.5 1.5.6-1.5.6L8 8.8l-.6-1.5-1.5-.6 1.5-.6z"
            fill="currentColor"
            strokeWidth="0.6"
          />
        </>
      )}
      {kind === "model" && (
        <>
          <circle cx="8" cy="8" r="2" />
          <circle cx="8" cy="8" r="4.3" />
          <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
        </>
      )}
    </svg>
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
