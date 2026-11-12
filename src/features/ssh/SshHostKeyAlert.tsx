/**
 * Host key mismatch alert dialog (TOFU).
 *
 * Triggered by the `ssh-hostkey-mismatch` event. Shows expected vs actual
 * fingerprints and offers to clear the host record after a second confirmation.
 */
import { useCallback, useEffect } from "react";
import type { SshHostKeyMismatchEvent } from "../../ipc/ssh";
import { sshForgetHost } from "../../ipc/ssh";
import { ask } from "../dialogStore";
import { useI18n } from "../../i18n";
import { localizeError } from "../../i18n";
import { useWorkspace } from "../../stores/workspace";

interface Props {
  event: SshHostKeyMismatchEvent;
  onClose(): void;
}

export default function SshHostKeyAlert({ event, onClose }: Props) {
  const { t } = useI18n();

  // Escape closes.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const handleForget = useCallback(async () => {
    const choice = await ask({
      title: t("ssh.hostkey.forgetConfirm.title"),
      message: t("ssh.hostkey.forgetConfirm.message", {
        host: event.host,
        port: String(event.port),
      }),
      buttons: [
        { label: t("ssh.connect.cancel"), value: "cancel" },
        { label: t("ssh.hostkey.forget"), value: "forget", variant: "danger" },
      ],
    });
    if (choice !== "forget") return;
    try {
      await sshForgetHost(event.host, event.port);
      onClose();
    } catch (e) {
      useWorkspace.getState().setError(localizeError(e));
    }
  }, [event, t, onClose]);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="dialog ssh-hostkey-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("ssh.hostkey.title")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="dialog__title">{t("ssh.hostkey.title")}</h2>
        <p className="dialog__message">
          {t("ssh.hostkey.message", {
            host: event.host,
            port: String(event.port),
            expected: event.expected,
            actual: event.actual,
          })}
        </p>
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={onClose}>
            {t("ssh.hostkey.cancel")}
          </button>
          <button type="button" className="btn btn--danger" onClick={() => void handleForget()}>
            {t("ssh.hostkey.forget")}
          </button>
        </div>
      </div>
    </div>
  );
}
