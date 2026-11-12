/**
 * Dialog for creating or editing an SSH connection profile.
 *
 * Auth mode switches visible fields: password shows password + remember;
 * key shows keyPath + passphrase + remember; agent shows nothing extra.
 */
import { useEffect, useState } from "react";
import type { SshAuth, SshProfile, SshProfileInfo } from "../../ipc/ssh";
import { useI18n } from "../../i18n";
import { useSshStore } from "../../stores/ssh";
import { localizeError } from "../../i18n";
import { isTauri } from "../../ipc/api";

interface Props {
  /** Existing profile to edit; omit for new. */
  profile?: SshProfileInfo;
  onClose(): void;
}

const EMPTY_PROFILE: SshProfile = {
  id: "",
  name: "",
  host: "",
  port: 22,
  username: "",
  auth: "password",
  keyPath: "",
  rememberSecret: false,
};

export default function SshConnectDialog({ profile, onClose }: Props) {
  const { t } = useI18n();
  const saveProfile = useSshStore((s) => s.saveProfile);

  const [form, setForm] = useState<SshProfile>(
    profile
      ? {
          id: profile.id,
          name: profile.name,
          host: profile.host,
          port: profile.port,
          username: profile.username,
          auth: profile.auth,
          keyPath: profile.keyPath,
          rememberSecret: profile.rememberSecret,
        }
      : { ...EMPTY_PROFILE }
  );
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Focus the first input on mount.
  useEffect(() => {
    const el = document.querySelector<HTMLInputElement>(".ssh-dialog__name");
    el?.focus();
  }, []);

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

  const setField = <K extends keyof SshProfile>(key: K, value: SshProfile[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError(null);
  };

  const handleSave = async () => {
    // Validate required fields
    if (!form.name.trim()) {
      setError(t("ssh.connect.required"));
      return;
    }
    if (!form.host.trim()) {
      setError(t("ssh.connect.required"));
      return;
    }
    if (!form.username.trim()) {
      setError(t("ssh.connect.required"));
      return;
    }
    if (form.port < 1 || form.port > 65535) {
      setError(t("ssh.connect.portRange"));
      return;
    }
    if (form.auth === "key" && !form.keyPath.trim()) {
      setError(t("ssh.connect.required"));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await saveProfile(
        form,
        form.auth === "password" && password ? password : undefined,
        form.auth === "key" && passphrase ? passphrase : undefined
      );
      onClose();
    } catch (e) {
      setError(localizeError(e));
    } finally {
      setSaving(false);
    }
  };

  const browseKeyPath = async () => {
    if (!isTauri) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ multiple: false, directory: false });
      if (selected) {
        const path = Array.isArray(selected) ? selected[0] : selected;
        if (path) setField("keyPath", path);
      }
    } catch {
      /* dialog cancelled or unavailable */
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="dialog ssh-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={profile ? t("ssh.connect.titleEdit") : t("ssh.connect.title")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="dialog__title">
          {profile ? t("ssh.connect.titleEdit") : t("ssh.connect.title")}
        </h2>

        <div className="ssh-dialog__fields">
          <label className="ssh-dialog__field">
            <span>{t("ssh.connect.name")}</span>
            <input
              className="ssh-dialog__name ai-settings__input"
              value={form.name}
              onChange={(e) => setField("name", e.target.value)}
              autoFocus
            />
          </label>

          <div className="ssh-dialog__row">
            <label className="ssh-dialog__field ssh-dialog__field--grow">
              <span>{t("ssh.connect.host")}</span>
              <input
                className="ai-settings__input"
                value={form.host}
                onChange={(e) => setField("host", e.target.value)}
              />
            </label>
            <label className="ssh-dialog__field ssh-dialog__field--port">
              <span>{t("ssh.connect.port")}</span>
              <input
                className="ai-settings__input"
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(e) => setField("port", Number(e.target.value) || 22)}
              />
            </label>
          </div>

          <label className="ssh-dialog__field">
            <span>{t("ssh.connect.username")}</span>
            <input
              className="ai-settings__input"
              value={form.username}
              onChange={(e) => setField("username", e.target.value)}
            />
          </label>

          <label className="ssh-dialog__field">
            <span>{t("ssh.connect.auth")}</span>
            <select
              className="ai-settings__input"
              value={form.auth}
              onChange={(e) => setField("auth", e.target.value as SshAuth)}
            >
              <option value="password">{t("ssh.connect.auth.password")}</option>
              <option value="key">{t("ssh.connect.auth.key")}</option>
              <option value="agent">{t("ssh.connect.auth.agent")}</option>
            </select>
          </label>

          {form.auth === "password" && (
            <label className="ssh-dialog__field">
              <span>{t("ssh.connect.password")}</span>
              <input
                className="ai-settings__input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={profile?.hasPassword ? "••••••" : ""}
              />
            </label>
          )}

          {form.auth === "key" && (
            <>
              <label className="ssh-dialog__field">
                <span>{t("ssh.connect.keyPath")}</span>
                <div className="ssh-dialog__key-row">
                  <input
                    className="ai-settings__input ssh-dialog__key-input"
                    value={form.keyPath}
                    onChange={(e) => setField("keyPath", e.target.value)}
                  />
                  <button type="button" className="btn" onClick={() => void browseKeyPath()}>
                    {t("ssh.connect.keyPath.browse")}
                  </button>
                </div>
              </label>
              <label className="ssh-dialog__field">
                <span>{t("ssh.connect.passphrase")}</span>
                <input
                  className="ai-settings__input"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder={profile?.hasPassphrase ? "••••••" : ""}
                />
              </label>
            </>
          )}

          {form.auth !== "agent" && (
            <label className="ssh-dialog__check">
              <input
                type="checkbox"
                checked={form.rememberSecret}
                onChange={(e) => setField("rememberSecret", e.target.checked)}
              />
              <span>{t("ssh.connect.remember")}</span>
            </label>
          )}
        </div>

        {error && <p className="ssh-dialog__error">{error}</p>}

        <div className="dialog__actions">
          <button type="button" className="btn" onClick={onClose}>
            {t("ssh.connect.cancel")}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={saving}
            onClick={() => void handleSave()}
          >
            {t("ssh.connect.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
