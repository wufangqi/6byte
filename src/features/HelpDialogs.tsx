import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { appInfo, type AppInfo } from "../ipc/api";
import { AppLogo } from "./MenuBar";

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
}

export function AboutDialog({ onClose }: { onClose(): void }) {
  const { t } = useI18n();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [copied, setCopied] = useState(false);
  useEscape(onClose);

  useEffect(() => {
    let cancel = false;
    void appInfo()
      .then((value) => {
        if (!cancel) setInfo(value);
      })
      .catch(() => {
        if (!cancel) setInfo({ version: "", tauriVersion: "", platform: "" });
      });
    return () => {
      cancel = true;
    };
  }, []);

  const unknown = t("about.unknown");
  const version = info?.version || unknown;
  const rows: { label: string; value: string }[] = [
    { label: t("about.platform"), value: info?.platform || unknown },
    { label: t("about.tauri"), value: info?.tauriVersion || unknown },
  ];

  const copy = () => {
    const text = [
      `6byte ${version}`,
      ...rows.map((row) => `${row.label}: ${row.value}`),
      `WebView: ${navigator.userAgent}`,
    ].join("\n");
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="dialog about"
        role="dialog"
        aria-modal="true"
        aria-label={t("menu.about")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <AppLogo className="about__logo" />
        <h2 className="about__name">6byte</h2>
        <p className="about__version">{t("about.version", { version })}</p>
        <dl className="about__meta">
          {rows.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
        <div className="dialog__actions">
          <button type="button" className="btn" disabled={!info} onClick={copy}>
            {copied ? t("about.copied") : t("about.copy")}
          </button>
          <button type="button" className="btn btn--primary" onClick={onClose}>
            {t("about.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}

const SHORTCUTS: { group: string; items: [string, string][] }[] = [
  {
    group: "shortcuts.group.file",
    items: [
      ["shortcuts.new", "Ctrl+N"],
      ["shortcuts.newWindow", "Ctrl+Shift+N"],
      ["shortcuts.open", "Ctrl+O"],
      ["shortcuts.openRecent", "Ctrl+R"],
      ["shortcuts.goTo", "Ctrl+P"],
      ["shortcuts.save", "Ctrl+S"],
      ["shortcuts.saveAs", "Ctrl+Shift+S"],
      ["shortcuts.close", "Ctrl+W"],
      ["shortcuts.rename", "F2"],
    ],
  },
  {
    group: "shortcuts.group.edit",
    items: [
      ["shortcuts.rewrite", "Ctrl+K"],
      ["shortcuts.acceptAi", "Tab"],
      ["shortcuts.dismissAi", "Esc"],
    ],
  },
  {
    group: "shortcuts.group.view",
    items: [
      ["shortcuts.grep", "Ctrl+Shift+F"],
      ["shortcuts.tree", "Ctrl+Shift+E"],
      ["shortcuts.preview", "Ctrl+Shift+M"],
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose(): void }) {
  const { t } = useI18n();
  useEscape(onClose);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="dialog shortcuts"
        role="dialog"
        aria-modal="true"
        aria-label={t("shortcuts.title")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog__head">
          <h2 className="dialog__title">{t("shortcuts.title")}</h2>
          <button
            type="button"
            className="dialog__close"
            aria-label={t("app.close")}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {SHORTCUTS.map((section) => (
          <section key={section.group} className="shortcuts__group">
            <h3 className="shortcuts__title">{t(section.group)}</h3>
            <dl className="shortcuts__list">
              {section.items.map(([label, keys]) => (
                <div key={label}>
                  <dt>{t(label)}</dt>
                  <dd>
                    {keys.split("+").map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}
