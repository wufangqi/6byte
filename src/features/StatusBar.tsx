import { useAiActivity } from "./aiActivity";
import { useI18n } from "../i18n";
import { formatSize } from "../lib/format";
import { useFileTree } from "../stores/fileTree";
import { useSshStore } from "../stores/ssh";
import { resolveDocument, selectActiveTab, useWorkspace } from "../stores/workspace";

const EOL_LABEL: Record<string, string> = {
  lf: "LF",
  crlf: "CRLF",
  cr: "CR",
};

function PanelIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
      <rect x="1.5" y="2" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" />
      <path d="M5.5 2v10" stroke="currentColor" />
    </svg>
  );
}

function SshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2 4h12M2 8h12M2 12h8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="13" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}

interface Props {
  previewOn?: boolean;
  canPreview?: boolean;
  onTogglePreview?: () => void;
  hasWorkspace?: boolean;
  treeHidden?: boolean;
  onToggleTree?: () => void;
  sshPanelOpen?: boolean;
  onToggleSshPanel?: () => void;
  aiPanelOpen?: boolean;
  onToggleAiPanel?: () => void;
}

export default function StatusBar({
  previewOn = false,
  canPreview = false,
  onTogglePreview,
  hasWorkspace = false,
  treeHidden = false,
  onToggleTree,
  sshPanelOpen = false,
  onToggleSshPanel,
  aiPanelOpen = false,
  onToggleAiPanel,
}: Props) {
  const tab = useWorkspace((state) => resolveDocument(state, selectActiveTab(state)));
  const workspaceName = useFileTree((state) => (state.rootPath ? state.rootName : ""));
  const workspacePath = useFileTree((state) => state.rootPath);
  const { t, tp } = useI18n();
  const activity = useAiActivity();
  const activityLabel =
    activity === "generating"
      ? t("status.ai.generating")
      : activity === "review"
        ? t("status.ai.review")
        : "";
  const activityItem = activityLabel ? (
    <button
      type="button"
      className={`statusbar__ai statusbar__ai--${activity}`}
      title={t("status.ai.title")}
      onClick={() => {
        if (!aiPanelOpen) onToggleAiPanel?.();
      }}
    >
      {activityLabel}
    </button>
  ) : null;
  const panelToggle = hasWorkspace && onToggleTree && (
    <button
      type="button"
      className={`statusbar__icon${treeHidden && !sshPanelOpen ? "" : " statusbar__icon--on"}`}
      aria-label={t("menu.fileTreeToggle")}
      aria-pressed={!treeHidden && !sshPanelOpen}
      title={t("menu.fileTreeToggle")}
      onClick={() => {
        if (sshPanelOpen) onToggleSshPanel?.();
        onToggleTree();
      }}
    >
      <PanelIcon />
    </button>
  );
  const sshToggle = onToggleSshPanel && (
    <button
      type="button"
      className={`statusbar__icon${sshPanelOpen ? " statusbar__icon--on" : ""}`}
      aria-label={t("ssh.panel.title")}
      aria-pressed={sshPanelOpen}
      title={t("ssh.panel.title")}
      onClick={() => {
        if (!sshPanelOpen && !treeHidden) onToggleTree?.();
        onToggleSshPanel();
      }}
    >
      <SshIcon />
    </button>
  );
  const workspace = workspaceName ? (
    <span className="statusbar__item" title={workspacePath ?? undefined}>
      {t("status.workspace", { name: workspaceName })}
    </span>
  ) : null;

  // Detect SSH remote tab and resolve profile name
  const isRemote = tab?.path?.startsWith("ssh://") ?? false;
  const sshProfiles = useSshStore((s) => s.profiles);
  const sshProfileName = (() => {
    if (!isRemote || !tab?.path) return "";
    const rest = tab.path.slice(6); // strip "ssh://"
    const slash = rest.indexOf("/");
    if (slash < 0) return "";
    const profileId = rest.slice(0, slash);
    const profile = sshProfiles.find((p) => p.id === profileId);
    return profile?.name ?? profileId;
  })();

  if (!tab) {
    return (
      <footer className="statusbar">
        {panelToggle}
        {sshToggle}
        {workspace}
        {activityItem}
        <span className="statusbar__item">{t("status.ready")}</span>
      </footer>
    );
  }

  return (
    <footer className="statusbar">
      {panelToggle}
      {sshToggle}
      {workspace}
      <span className="statusbar__item statusbar__path" title={tab.path ?? undefined}>
        {tab.path ?? t("status.unsavedFile")}
      </span>

      {isRemote && sshProfileName && (
        <span className="statusbar__item statusbar__ssh-badge">
          {t("ssh.status.badge", { name: sshProfileName })}
        </span>
      )}

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
          className={`statusbar__action${previewOn ? " statusbar__action--on" : ""}`}
          aria-pressed={previewOn}
          title={t(previewOn ? "status.preview.titleBack" : "status.preview.title")}
          onClick={onTogglePreview}
        >
          {t("status.preview")}
        </button>
      )}

      {activityItem}
      {onToggleAiPanel && (
        <button
          type="button"
          className={`statusbar__action${aiPanelOpen ? " statusbar__action--on" : ""}`}
          aria-pressed={aiPanelOpen}
          title={t("status.aiPanel.title")}
          onClick={onToggleAiPanel}
        >
          {t("status.aiPanel")}
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
