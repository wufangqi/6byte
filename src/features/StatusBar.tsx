import { useI18n } from "../i18n";
import { selectActiveTab, useWorkspace } from "../stores/workspace";
import { formatSize } from "../lib/format";

const EOL_LABEL: Record<string, string> = {
  lf: "LF",
  crlf: "CRLF",
  cr: "CR",
};

interface Props {
  previewOn?: boolean;
  canPreview?: boolean;
  onTogglePreview?: () => void;
}

export default function StatusBar({
  previewOn = false,
  canPreview = false,
  onTogglePreview,
}: Props) {
  const tab = useWorkspace(selectActiveTab);
  const { t, tp } = useI18n();

  if (!tab) {
    return (
      <footer className="statusbar">
        <span className="statusbar__item">{t("status.ready")}</span>
      </footer>
    );
  }

  return (
    <footer className="statusbar">
      <span className="statusbar__item statusbar__path" title={tab.path ?? undefined}>
        {tab.path ?? t("status.unsavedFile")}
      </span>

      {tab.mode === "large" && (
        <span className="statusbar__warn" title={t("status.large.title")}>
          {t("status.large")}
        </span>
      )}

      {tab.meta.lossy && (
        <span className="statusbar__warn" title={t("status.lossy.title")}>
          {t("status.lossy")}
        </span>
      )}

      {tab.meta.mixedEol && (
        <span className="statusbar__warn" title={t("status.mixed.title")}>
          {t("status.mixed")}
        </span>
      )}

      <span className="statusbar__spacer" />

      {canPreview && onTogglePreview && (
        <button
          type="button"
          className={`statusbar__action ${previewOn ? "statusbar__action--on" : ""}`}
          title={t("status.preview.title")}
          onClick={onTogglePreview}
        >
          {t("status.preview")}
        </button>
      )}

      <span className="statusbar__item">{tp("status.lines", tab.lines, { count: tab.lines })}</span>
      <span className="statusbar__item">
        {tab.mode === "large" ? "—" : t("status.chars", { count: tab.chars })}
      </span>
      <span className="statusbar__item">{formatSize(tab.size)}</span>
      <span className="statusbar__item" title={t("status.charset.title")}>
        {tab.meta.charset}
        {tab.meta.bom ? " BOM" : ""}
      </span>
      <span
        className={`statusbar__item ${tab.meta.mixedEol ? "statusbar__item--mixed" : ""}`}
        title={tab.meta.mixedEol ? t("status.eol.mixedTitle") : t("status.eol.title")}
      >
        {EOL_LABEL[tab.meta.eol] ?? tab.meta.eol}
      </span>
      {tab.mode === "large" ? (
        <span className="statusbar__item" title={t("status.readonly.title")}>
          {t("status.readonly")}
        </span>
      ) : (
        <span className={`statusbar__item ${tab.dirty ? "statusbar__item--dirty" : ""}`}>
          {tab.dirty ? t("status.dirty") : t("status.saved")}
        </span>
      )}
    </footer>
  );
}
