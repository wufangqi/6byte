import { useI18n } from "../i18n";
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
  const { t } = useI18n();

  return (
    <div className="welcome">
      <div className="welcome__inner">
        <h1 className="welcome__title">6byte</h1>
        <p className="welcome__sub">{t("welcome.sub")}</p>

        <div className="welcome__actions">
          <button className="btn btn--primary" onClick={onOpen} disabled={!isTauri}>
            {t("welcome.open")}
            <kbd>Ctrl+O</kbd>
          </button>
          <button className="btn" onClick={onNew}>
            {t("welcome.new")}
            <kbd>Ctrl+N</kbd>
          </button>
        </div>

        {!isTauri && (
          <p className="welcome__hint">
            {t("welcome.browserBefore")}
            <code>pnpm tauri dev</code>
            {t("welcome.browserAfter")}
          </p>
        )}

        {recent.length > 0 && (
          <div className="welcome__recent">
            <div className="welcome__recent-head">
              <h2>{t("welcome.recent")}</h2>
              <button
                type="button"
                className="welcome__recent-clear"
                title={t("welcome.clearTitle")}
                onClick={() => setRecent([])}
              >
                {t("welcome.clear")}
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
                    title={t("welcome.removeTitle")}
                    aria-label={t("welcome.removeLabel", { name: fileName(path) })}
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
