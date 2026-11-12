/**
 * Port forwarding panel: lists active forwards and allows adding new ones.
 *
 * Real-time updates come from the `ssh-forward-update` event, which the
 * parent SshPanel subscribes to and pushes into the store.
 */
import { useCallback, useState } from "react";
import type { ForwardSpec } from "../../ipc/ssh";
import { useI18n } from "../../i18n";
import { localizeError } from "../../i18n";
import { formatSize } from "../../lib/format";
import { useSshStore } from "../../stores/ssh";
import { validateForwardSpec } from "./forwardSpec";

interface Props {
  profileId: string;
}

type AddKind = "local" | "remote" | "dynamic";

export default function SshPortsPanel({ profileId }: Props) {
  const { t, tp } = useI18n();
  const forwards = useSshStore((s) => s.forwards.get(profileId) ?? []);
  const addForward = useSshStore((s) => s.addForward);
  const stopForward = useSshStore((s) => s.stopForward);

  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<AddKind>("local");
  const [listenPort, setListenPort] = useState("0");
  const [targetHost, setTargetHost] = useState("localhost");
  const [targetPort, setTargetPort] = useState("80");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleAdd = useCallback(async () => {
    let spec: ForwardSpec;
    if (kind === "local") {
      spec = {
        kind: "local",
        localPort: Number(listenPort) || 0,
        remoteHost: targetHost,
        remotePort: Number(targetPort) || 0,
      };
    } else if (kind === "remote") {
      spec = {
        kind: "remote",
        remotePort: Number(listenPort) || 0,
        localHost: targetHost,
        localPort: Number(targetPort) || 0,
      };
    } else {
      spec = { kind: "dynamic", localPort: Number(listenPort) || 0 };
    }

    const errors = validateForwardSpec(spec);
    if (errors.length > 0) {
      setError(t("ssh.connect.required"));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await addForward(profileId, spec);
      setAdding(false);
      setListenPort("0");
      setTargetHost("localhost");
      setTargetPort("80");
    } catch (e) {
      setError(localizeError(e));
    } finally {
      setSaving(false);
    }
  }, [kind, listenPort, targetHost, targetPort, profileId, addForward, t]);

  const describeSpec = (spec: ForwardSpec): string => {
    if (spec.kind === "local")
      return `-L ${spec.localPort} → ${spec.remoteHost}:${spec.remotePort}`;
    if (spec.kind === "remote")
      return `-R ${spec.remotePort} → ${spec.localHost}:${spec.localPort}`;
    return `-D ${spec.localPort} (SOCKS)`;
  };

  return (
    <div className="ssh-ports">
      <div className="ssh-ports__header">
        <span className="ssh-ports__title">{t("ssh.ports.title")}</span>
        {!adding && (
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            {t("ssh.ports.add")}
          </button>
        )}
      </div>

      {adding && (
        <div className="ssh-ports__add">
          <label className="ssh-ports__field">
            <span>{t("ssh.ports.kind")}</span>
            <select
              className="ai-settings__input"
              value={kind}
              onChange={(e) => setKind(e.target.value as AddKind)}
            >
              <option value="local">{t("ssh.ports.kind.local")}</option>
              <option value="remote">{t("ssh.ports.kind.remote")}</option>
              <option value="dynamic">{t("ssh.ports.kind.dynamic")}</option>
            </select>
          </label>

          <label className="ssh-ports__field">
            <span>{t("ssh.ports.listenPort")}</span>
            <input
              className="ai-settings__input"
              type="number"
              min={0}
              max={65535}
              value={listenPort}
              onChange={(e) => setListenPort(e.target.value)}
              placeholder={t("ssh.ports.autoAssign")}
            />
          </label>

          {kind !== "dynamic" && (
            <>
              <label className="ssh-ports__field">
                <span>{t("ssh.ports.targetHost")}</span>
                <input
                  className="ai-settings__input"
                  value={targetHost}
                  onChange={(e) => setTargetHost(e.target.value)}
                />
              </label>
              <label className="ssh-ports__field">
                <span>{t("ssh.ports.targetPort")}</span>
                <input
                  className="ai-settings__input"
                  type="number"
                  min={0}
                  max={65535}
                  value={targetPort}
                  onChange={(e) => setTargetPort(e.target.value)}
                />
              </label>
            </>
          )}

          {error && <p className="ssh-ports__error">{error}</p>}

          <div className="ssh-ports__add-actions">
            <button type="button" className="btn" onClick={() => setAdding(false)}>
              {t("ssh.connect.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={saving}
              onClick={() => void handleAdd()}
            >
              {t("ssh.ports.add")}
            </button>
          </div>
        </div>
      )}

      {forwards.length === 0 && !adding && (
        <div className="ssh-ports__empty">{t("ssh.ports.empty")}</div>
      )}

      {forwards.length > 0 && (
        <table className="ssh-ports__table">
          <thead>
            <tr>
              <th>{t("ssh.ports.kind")}</th>
              <th>{describeSpecHeader(t)}</th>
              <th></th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {forwards.map((fwd) => (
              <tr key={fwd.id}>
                <td>
                  <span className={`ssh-ports__status ssh-ports__status--${fwd.status}`}>
                    {t(`ssh.ports.status.${fwd.status}`)}
                  </span>
                </td>
                <td className="ssh-ports__spec">{describeSpec(fwd.spec)}</td>
                <td className="ssh-ports__connections">
                  {tp("ssh.ports.connections", fwd.connections, { count: fwd.connections })}
                </td>
                <td className="ssh-ports__traffic">
                  {t("ssh.ports.traffic", {
                    up: formatSize(fwd.upBytes),
                    down: formatSize(fwd.downBytes),
                  })}
                </td>
                <td>
                  {fwd.status === "active" && (
                    <button
                      type="button"
                      className="btn ssh-ports__stop"
                      onClick={() => void stopForward(profileId, fwd.id)}
                    >
                      {t("ssh.ports.stop")}
                    </button>
                  )}
                  {fwd.status === "error" && fwd.error && (
                    <span className="ssh-ports__error-text" title={fwd.error}>
                      ⚠
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function describeSpecHeader(t: (key: string) => string): string {
  return t("ssh.ports.listenPort");
}
