import { useEffect, useId, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { dismissActiveCompletion } from "../editor/completion";
import { setLocale, useI18n, type Locale } from "../i18n";
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
import { setThemePreference, useThemePreference, type ThemePreference } from "./theme";

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
  onRename(): void;
  onOpenModelSettings(): void;
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
  onRename,
  onOpenModelSettings,
  onAbout,
  onShortcuts,
  onFeedback,
  canAsk = false,
  aiMarkerEnabled = true,
  onToggleAiMarker,
}: Props) {
  const preference = useThemePreference();
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
  const { t, locale } = useI18n();
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

  const themes: { id: ThemePreference; label: string }[] = [
    { id: "light", label: t("menu.light") },
    { id: "dark", label: t("menu.dark") },
    { id: "system", label: t("menu.system") },
  ];
  const languages: { id: Locale; label: string }[] = [
    { id: "zh", label: t("menu.langZh") },
    { id: "en", label: t("menu.langEn") },
  ];

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
              <div className="menu__sep" />
              <div className="menu__label">{t("menu.theme")}</div>
              {themes.map((theme) => (
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
              <div className="menu__sep" />
              <div className="menu__label">{t("menu.language")}</div>
              {languages.map((language) => (
                <button
                  key={language.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={language.id === locale}
                  className="menu__item"
                  onClick={() => {
                    setLocale(language.id);
                    setMenu(null);
                  }}
                >
                  <span className="menu__check" aria-hidden="true">
                    {language.id === locale ? "✓" : ""}
                  </span>
                  {language.label}
                </button>
              ))}
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
              <FileItem label={t("menu.about")} onClick={onAbout} close={() => setMenu(null)} />
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

/** Same mark as the app icon: text lines and a caret on a rounded gradient. */
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

function ActionIcon({ kind }: { kind: "complete" | "marker" | "model" }) {
  return (
    <svg
      width="16"
      height="16"
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
