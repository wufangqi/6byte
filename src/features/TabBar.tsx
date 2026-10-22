import { useWorkspace } from "../stores/workspace";

interface Props {
  onClose: (id: string) => void;
}

export default function TabBar({ onClose }: Props) {
  const tabs = useWorkspace((s) => s.tabs);
  const activeId = useWorkspace((s) => s.activeId);
  const setActive = useWorkspace((s) => s.setActive);
  const newTab = useWorkspace((s) => s.newTab);

  if (tabs.length === 0) return null;

  return (
    <div className="tabbar">
      <div className="tabbar__tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
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
            {tab.dirty && <span className="tab__dot" aria-label="未保存" />}
            <button
              className="tab__close"
              aria-label="关闭"
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
      <button className="tabbar__new" title="新建 (Ctrl+N)" onClick={newTab}>
        +
      </button>
    </div>
  );
}
