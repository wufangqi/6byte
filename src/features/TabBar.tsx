import { useI18n } from "../i18n";
import { useWorkspace } from "../stores/workspace";

interface Props {
  onClose: (id: string) => void;
}

export default function TabBar({ onClose }: Props) {
  const tabs = useWorkspace((s) => s.tabs);
  const activeId = useWorkspace((s) => s.activeId);
  const setActive = useWorkspace((s) => s.setActive);
  const newTab = useWorkspace((s) => s.newTab);
  const { t } = useI18n();

  if (tabs.length === 0) return null;

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
      </div>
      <button type="button" className="tabbar__new" title={t("tab.new")} onClick={newTab}>
        +
      </button>
    </div>
  );
}
