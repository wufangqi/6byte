import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { SETTINGS_TAB_ID, useWorkspace } from "../stores/workspace";
import { ActionIcon } from "./MenuBar";

interface Props {
  onClose: (id: string) => void;
  onRename: (id: string) => void;
}

interface MenuState {
  tabId: string;
  x: number;
  y: number;
}

export default function TabBar({ onClose, onRename }: Props) {
  const tabs = useWorkspace((s) => s.tabs);
  const activeId = useWorkspace((s) => s.activeId);
  const setActive = useWorkspace((s) => s.setActive);
  const newTab = useWorkspace((s) => s.newTab);
  const settingsOpen = useWorkspace((s) => s.settingsOpen);
  const closeSettings = useWorkspace((s) => s.closeSettings);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const { t } = useI18n();

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menu]);

  if (tabs.length === 0 && !settingsOpen) return null;
  const settingsActive = activeId === SETTINGS_TAB_ID;

  const menuTab = menu ? tabs.find((tab) => tab.id === menu.tabId) : undefined;

  return (
    <div className="tabbar">
      <div className="tabbar__tabs" role="tablist">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeId}
            className={`tab ${tab.id === activeId ? "tab--active" : ""}`}
            title={tab.path ?? tab.name}
            onClick={() => setActive(tab.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              setActive(tab.id);
              setMenu({ tabId: tab.id, x: event.clientX, y: event.clientY });
            }}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(tab.id);
              }
            }}
          >
            <span className="tab__name">{tab.name}</span>
            {tab.dirty && <span className="tab__dot" aria-label={t("tab.unsaved")} />}
            <button
              type="button"
              className="tab__close"
              aria-label={t("tab.close")}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        {settingsOpen && (
          <div
            role="tab"
            aria-selected={settingsActive}
            className={`tab tab--settings ${settingsActive ? "tab--active" : ""}`}
            onClick={() => setActive(SETTINGS_TAB_ID)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeSettings();
              }
            }}
          >
            <ActionIcon kind="model" size={13} />
            <span className="tab__name">{t("settings.title")}</span>
            <button
              type="button"
              className="tab__close"
              aria-label={t("tab.close")}
              onClick={(e) => {
                e.stopPropagation();
                closeSettings();
              }}
            >
              ×
            </button>
          </div>
        )}
      </div>
      <button type="button" className="tabbar__new" title={t("tab.new")} onClick={newTab}>
        +
      </button>
      {menu && menuTab && (
        <div
          className="menu tabbar__menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setMenu(null);
            }
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="menu__item"
            onClick={() => {
              setMenu(null);
              onRename(menuTab.id);
            }}
          >
            {t("tab.rename")}
            <span className="menu__shortcut">F2</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu__item"
            onClick={() => {
              setMenu(null);
              onClose(menuTab.id);
            }}
          >
            {t("tab.close")}
          </button>
        </div>
      )}
    </div>
  );
}
