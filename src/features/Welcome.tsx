import { useWorkspace } from "../stores/workspace";
import { isTauri } from "../ipc/api";

interface Props {
  onOpen: () => void;
  onNew: () => void;
  onOpenPath: (path: string) => void;
}

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

export default function Welcome({ onOpen, onNew, onOpenPath }: Props) {
  const recent = useWorkspace((s) => s.recent);
  const removeRecent = useWorkspace((s) => s.removeRecent);
  const setRecent = useWorkspace((s) => s.setRecent);

  return (
    <div className="welcome">
      <div className="welcome__inner">
        <h1 className="welcome__title">6byte</h1>
        <p className="welcome__sub">
          打开 md / txt / log，随时让 AI 帮你改写。数据留在本机，默认不上传。
        </p>

        <div className="welcome__actions">
          <button className="btn btn--primary" onClick={onOpen} disabled={!isTauri}>
            打开文件
            <kbd>Ctrl+O</kbd>
          </button>
          <button className="btn" onClick={onNew}>
            新建
            <kbd>Ctrl+N</kbd>
          </button>
        </div>

        {!isTauri && (
          <p className="welcome__hint">
            当前是浏览器预览模式：文件读写需要运行 <code>pnpm tauri dev</code>。
          </p>
        )}

        {recent.length > 0 && (
          <div className="welcome__recent">
            <div className="welcome__recent-head">
              <h2>最近打开</h2>
              <button
                type="button"
                className="welcome__recent-clear"
                title="清空最近打开列表"
                onClick={() => setRecent([])}
              >
                清空
              </button>
            </div>
            <ul>
              {recent.map((path) => (
                <li key={path} className="welcome__recent-item">
                  <button className="link" title={path} onClick={() => onOpenPath(path)}>
                    <span className="welcome__recent-name">{fileName(path)}</span>
                    <span className="welcome__recent-path">{path}</span>
                  </button>
                  <button
                    type="button"
                    className="welcome__recent-remove"
                    title="从最近打开中移除"
                    aria-label={`从最近打开中移除 ${fileName(path)}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      removeRecent(path);
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
