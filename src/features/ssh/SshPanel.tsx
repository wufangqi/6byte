/**
 * SSH sidebar panel: connection selector + Files / Ports tabs.
 *
 * Shows a welcome state when no profiles exist or none are connected.
 */
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import {
  onSshForwardUpdate,
  onSshHostKeyMismatch,
  onSshSession,
  onSshTransfer,
} from "../../ipc/ssh";
import type { SshHostKeyMismatchEvent } from "../../ipc/ssh";
import { useSshStore } from "../../stores/ssh";
import { ask } from "../dialogStore";
import SshConnectDialog from "./SshConnectDialog";
import SshHostKeyAlert from "./SshHostKeyAlert";
import SshPortsPanel from "./SshPortsPanel";
import SshTree from "./SshTree";

interface Props {
  width: number;
}

type Tab = "files" | "ports";

export default function SshPanel({ width }: Props) {
  const { t } = useI18n();
  const profiles = useSshStore((s) => s.profiles);
  const sessions = useSshStore((s) => s.sessions);
  const refreshProfiles = useSshStore((s) => s.refreshProfiles);
  const connect = useSshStore((s) => s.connect);
  const disconnect = useSshStore((s) => s.disconnect);
  const deleteProfile = useSshStore((s) => s.deleteProfile);
  const updateSession = useSshStore((s) => s.updateSession);
  const updateForwards = useSshStore((s) => s.updateForwards);
  const updateTransfer = useSshStore((s) => s.updateTransfer);

  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [tab, setTab] = useState<Tab>("files");
  const [dialogMode, setDialogMode] = useState<"new" | "edit" | null>(null);
  const [hostKeyEvent, setHostKeyEvent] = useState<SshHostKeyMismatchEvent | null>(null);

  // Load profiles on mount.
  useEffect(() => {
    void refreshProfiles();
  }, [refreshProfiles]);

  // Subscribe to SSH events.
  useEffect(() => {
    let unlistenSession: (() => void) | undefined;
    let unlistenForward: (() => void) | undefined;
    let unlistenTransfer: (() => void) | undefined;
    let unlistenHostKey: (() => void) | undefined;
    let disposed = false;

    void onSshSession((info) => updateSession(info)).then((fn) => {
      if (!disposed) unlistenSession = fn;
    });
    void onSshForwardUpdate((event) => updateForwards(event.profileId, event.forwards)).then(
      (fn) => {
        if (!disposed) unlistenForward = fn;
      }
    );
    void onSshTransfer((event) => updateTransfer(event)).then((fn) => {
      if (!disposed) unlistenTransfer = fn;
    });
    void onSshHostKeyMismatch((event) => setHostKeyEvent(event)).then((fn) => {
      if (!disposed) unlistenHostKey = fn;
    });

    return () => {
      disposed = true;
      unlistenSession?.();
      unlistenForward?.();
      unlistenTransfer?.();
      unlistenHostKey?.();
    };
  }, [updateSession, updateForwards, updateTransfer]);

  // Derive effective profile id: explicit selection, or first connected, or first profile.
  const effectiveProfileId =
    selectedProfileId ||
    (() => {
      const connected = sessions.find((s) => s.state === "connected");
      if (connected) return connected.profileId;
      return profiles[0]?.id ?? "";
    })();

  const activeSession = sessions.find((s) => s.profileId === effectiveProfileId);
  const isConnected = activeSession?.state === "connected";

  const handleConnect = useCallback(async () => {
    if (!effectiveProfileId) return;
    try {
      await connect(effectiveProfileId);
    } catch {
      /* error shown via store */
    }
  }, [effectiveProfileId, connect]);

  const handleDisconnect = useCallback(async () => {
    if (!effectiveProfileId) return;
    try {
      await disconnect(effectiveProfileId);
    } catch {
      /* error shown via store */
    }
  }, [effectiveProfileId, disconnect]);

  const handleDelete = useCallback(async () => {
    if (!effectiveProfileId) return;
    const profile = profiles.find((p) => p.id === effectiveProfileId);
    if (!profile) return;
    const choice = await ask({
      title: t("ssh.panel.deleteProfile"),
      message: `"${profile.name}"?`,
      buttons: [
        { label: t("ssh.connect.cancel"), value: "cancel" },
        { label: t("ssh.panel.deleteProfile"), value: "delete", variant: "danger" },
      ],
    });
    if (choice !== "delete") return;
    try {
      await deleteProfile(effectiveProfileId);
      setSelectedProfileId("");
    } catch {
      /* error shown via store */
    }
  }, [effectiveProfileId, profiles, deleteProfile, t]);

  const editingProfile =
    dialogMode === "edit" ? profiles.find((p) => p.id === effectiveProfileId) : undefined;

  return (
    <div className="ssh-panel" style={{ width }}>
      {/* Empty state: no saved connection yet. */}
      {profiles.length === 0 ? (
        <div className="ssh-panel__empty">
          <div className="ssh-panel__empty-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor">
              <rect x="2.5" y="4" width="19" height="13" rx="2" strokeWidth="1.5" />
              <path d="M8 20h8M12 17v3" strokeWidth="1.5" strokeLinecap="round" />
              <path
                d="M7 9.5l2.5 2L7 13.5"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <p className="ssh-panel__empty-title">{t("ssh.panel.empty.title")}</p>
          <p className="ssh-panel__empty-hint">{t("ssh.panel.empty.hint")}</p>
          <button type="button" className="btn btn--primary" onClick={() => setDialogMode("new")}>
            {t("ssh.panel.newProfile")}
          </button>
        </div>
      ) : (
        <>
          {/* Connection selector + actions */}
          <div className="ssh-panel__header">
            <select
              className="settings__input settings__select ssh-panel__select"
              value={effectiveProfileId}
              onChange={(e) => setSelectedProfileId(e.target.value)}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.host})
                </option>
              ))}
            </select>

            <div className="ssh-panel__actions">
              {!isConnected ? (
                <button
                  type="button"
                  className="btn btn--primary ssh-panel__action-btn"
                  title={t("ssh.panel.connect")}
                  aria-label={t("ssh.panel.connect")}
                  disabled={!effectiveProfileId || activeSession?.state === "connecting"}
                  onClick={() => void handleConnect()}
                >
                  {activeSession?.state === "connecting"
                    ? t("ssh.panel.connecting")
                    : t("ssh.panel.connect")}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn ssh-panel__action-btn"
                  title={t("ssh.panel.disconnect")}
                  aria-label={t("ssh.panel.disconnect")}
                  onClick={() => void handleDisconnect()}
                >
                  {t("ssh.panel.disconnect")}
                </button>
              )}
            </div>
          </div>

          <div className="ssh-panel__toolbar">
            <span className="ssh-panel__state">
              {isConnected ? (
                <>
                  <span className="ssh-panel__dot ssh-panel__dot--on" aria-hidden="true" />
                  {profiles.find((p) => p.id === effectiveProfileId)?.name}
                </>
              ) : (
                <>
                  <span className="ssh-panel__dot" aria-hidden="true" />
                  {t("ssh.panel.notConnected")}
                </>
              )}
            </span>
            <div className="ssh-panel__icon-actions">
              <button
                type="button"
                className="ssh-panel__icon-btn"
                title={t("ssh.panel.newProfile")}
                aria-label={t("ssh.panel.newProfile")}
                onClick={() => setDialogMode("new")}
              >
                +
              </button>
              <button
                type="button"
                className="ssh-panel__icon-btn"
                title={t("ssh.panel.editProfile")}
                aria-label={t("ssh.panel.editProfile")}
                disabled={!effectiveProfileId}
                onClick={() => setDialogMode("edit")}
              >
                ✎
              </button>
              <button
                type="button"
                className="ssh-panel__icon-btn ssh-panel__icon-btn--danger"
                title={t("ssh.panel.deleteProfile")}
                aria-label={t("ssh.panel.deleteProfile")}
                disabled={!effectiveProfileId}
                onClick={() => void handleDelete()}
              >
                🗑
              </button>
            </div>
          </div>
        </>
      )}

      {/* Session status */}
      {activeSession && activeSession.state !== "connected" && activeSession.message && (
        <div className="ssh-panel__status ssh-panel__status--error">{activeSession.message}</div>
      )}

      {/* Tabs */}
      {isConnected && (
        <>
          <div className="ssh-panel__tabs">
            <button
              type="button"
              className={`ssh-panel__tab ${tab === "files" ? "ssh-panel__tab--active" : ""}`}
              onClick={() => setTab("files")}
            >
              {t("ssh.panel.tab.files")}
            </button>
            <button
              type="button"
              className={`ssh-panel__tab ${tab === "ports" ? "ssh-panel__tab--active" : ""}`}
              onClick={() => setTab("ports")}
            >
              {t("ssh.panel.tab.ports")}
            </button>
          </div>

          <div className="ssh-panel__content">
            {tab === "files" && (
              <SshTree profileId={effectiveProfileId} homePath={activeSession?.home ?? "/"} />
            )}
            {tab === "ports" && <SshPortsPanel profileId={effectiveProfileId} />}
          </div>
        </>
      )}

      {/* Not connected yet, but a profile exists. */}
      {!isConnected && profiles.length > 0 && (
        <div className="ssh-panel__welcome">
          <p>{t("ssh.panel.welcome")}</p>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!effectiveProfileId || activeSession?.state === "connecting"}
            onClick={() => void handleConnect()}
          >
            {t("ssh.panel.connect")}
          </button>
        </div>
      )}

      {/* Dialogs */}
      {dialogMode && (
        <SshConnectDialog profile={editingProfile} onClose={() => setDialogMode(null)} />
      )}

      {hostKeyEvent && (
        <SshHostKeyAlert event={hostKeyEvent} onClose={() => setHostKeyEvent(null)} />
      )}
    </div>
  );
}
