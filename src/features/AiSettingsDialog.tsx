import { useEffect, useRef, useState } from "react";
import { dismissActiveCompletion } from "../editor/completion";
import { ask } from "./dialogStore";
import { endpointOrigin } from "./aiStream";
import { localizeError, useI18n } from "../i18n";
import { aiBoundOrigin, aiClearKey, aiHasKey, aiProbe, aiSetKey, isTauri } from "../ipc/api";
import {
  SAVED_KEY_MASK,
  activeModel,
  activeModelEntry,
  activeProvider,
  addModel,
  addProvider,
  focusProvider,
  isSavedKeyMask,
  loadAiSettings,
  removeModel,
  removeProvider,
  saveAiSettings,
  updateModel,
  updateProvider,
  withOllamaPreset,
  type AiCatalog,
  type Provider,
  type ProviderModel,
} from "./aiSettings";
import {
  completionChoices,
  loadCompletionSettings,
  saveCompletionSettings,
  type CompletionSettings,
} from "./completionSettings";

interface Props {
  onClose(): void;
}

/** A mask of only asterisks means "keep the key already in the keychain". */
function enteredKey(value: string): string {
  const trimmed = value.trim();
  return isSavedKeyMask(trimmed) ? "" : trimmed;
}

/** Providers, then the models under the selected provider. Keys stay in the OS keychain. */
export default function AiSettingsDialog({ onClose }: Props) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<AiCatalog>(loadAiSettings);
  const [completion, setCompletion] = useState<CompletionSettings>(loadCompletionSettings);
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const savedIds = useRef(loadAiSettings().providers.map((provider) => provider.id));
  const boundOrigin = useRef<string | null>(null);
  const storedKey = useRef(false);
  const keyLoaded = useRef(false);
  const provider = activeProvider(catalog);
  const model = activeModelEntry(catalog);
  const providerId = provider?.id ?? "";
  const ready = Boolean(provider?.baseUrl.trim() && model?.model.trim());
  const choices = completionChoices(catalog);
  const completionValue =
    completion.providerId && completion.modelId
      ? `${completion.providerId}|${completion.modelId}`
      : "";

  const editCompletion = (patch: Partial<CompletionSettings>) => {
    const next = { ...completion, ...patch };
    setCompletion(next);
    saveCompletionSettings(next);
    if (!next.enabled) dismissActiveCompletion();
  };

  useEffect(() => {
    keyLoaded.current = false;
    storedKey.current = false;
    boundOrigin.current = null;
    if (!isTauri || !providerId) return;
    let cancel = false;
    void aiHasKey(providerId)
      .then(async (stored) => {
        if (cancel) return;
        setHasKey(stored);
        storedKey.current = stored;
        boundOrigin.current = stored ? await aiBoundOrigin(providerId) : null;
        keyLoaded.current = true;
        if (stored) {
          setApiKey((current) =>
            isSavedKeyMask(current) || current.trim() === "" ? SAVED_KEY_MASK : current
          );
        }
      })
      .catch(() => {
        if (cancel) return;
        keyLoaded.current = true;
        storedKey.current = false;
        boundOrigin.current = null;
        setHasKey(false);
      });
    return () => {
      cancel = true;
    };
  }, [providerId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const forgetKey = () => {
    setApiKey("");
    setHasKey(false);
    keyLoaded.current = false;
  };

  const editProvider = (patch: Partial<Provider>) => {
    if (!provider) return;
    setCatalog((current) => updateProvider(current, { ...provider, ...patch }));
  };

  const editModel = (patch: Partial<ProviderModel>) => {
    if (!provider || !model) return;
    setCatalog((current) => updateModel(current, provider.id, { ...model, ...patch }));
  };

  const persist = async () => {
    const next: AiCatalog = {
      ...catalog,
      providers: catalog.providers.map((item) => ({
        ...item,
        name: item.name.trim() || item.models[0]?.model.trim() || t("ai.provider.unnamed"),
        baseUrl: item.baseUrl.trim(),
        models: item.models.map((entry) => ({
          ...entry,
          name: entry.name.trim() || entry.model.trim() || t("ai.model.unnamed"),
          model: entry.model.trim(),
        })),
      })),
    };
    saveAiSettings(next);
    setCatalog(next);
    const removed = savedIds.current.filter((id) => !next.providers.some((item) => item.id === id));
    if (isTauri) {
      for (const id of removed) await aiClearKey(id);
    }
    savedIds.current = next.providers.map((item) => item.id);
    const typed = enteredKey(apiKey);
    const current = activeProvider(next);
    if (typed && current) {
      await aiSetKey(typed, current.id, current.baseUrl);
      boundOrigin.current = endpointOrigin(current.baseUrl);
      storedKey.current = true;
      keyLoaded.current = true;
      setApiKey(SAVED_KEY_MASK);
      setHasKey(true);
    }
    return activeModel(next);
  };

  const confirmHostChange = async (baseUrl: string): Promise<"ok" | "cleared" | "cancel"> => {
    const typed = enteredKey(apiKey);
    if (!isTauri || !provider || typed) return "ok";
    if (!keyLoaded.current) {
      const stored = await aiHasKey(provider.id);
      storedKey.current = stored;
      boundOrigin.current = stored ? await aiBoundOrigin(provider.id) : null;
      keyLoaded.current = true;
      setHasKey(stored);
    }
    if (!storedKey.current) return "ok";
    const nextOrigin = endpointOrigin(baseUrl);
    const previous = boundOrigin.current;
    if (!nextOrigin || previous === nextOrigin) return "ok";
    const choice = await ask({
      title: t("ai.hostChanged.title"),
      message: t("ai.hostChanged.message"),
      buttons: [
        { label: t("dialog.cancel"), value: "cancel" },
        { label: t("ai.hostChanged.confirm"), value: "confirm", variant: "danger" },
      ],
    });
    if (choice !== "confirm") return "cancel";
    await aiClearKey(provider.id);
    storedKey.current = false;
    boundOrigin.current = null;
    keyLoaded.current = true;
    setHasKey(false);
    setApiKey("");
    return "cleared";
  };

  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const current = activeProvider(catalog);
      const hostChange = current ? await confirmHostChange(current.baseUrl) : "ok";
      if (hostChange === "cancel") return;
      const typed = enteredKey(apiKey);
      await persist();
      setStatus(
        hostChange === "cleared"
          ? t("ai.hostChanged.cleared")
          : typed
            ? t("ai.saved")
            : t("ai.savedPublic")
      );
    } catch (error) {
      setStatus(localizeError(error));
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async () => {
    if (!provider) return;
    setBusy(true);
    setStatus(null);
    try {
      if (hasKey || isSavedKeyMask(apiKey)) await aiClearKey(provider.id);
      setApiKey("");
      setHasKey(false);
      setStatus(t("ai.cleared"));
    } catch (error) {
      setStatus(localizeError(error));
    } finally {
      setBusy(false);
    }
  };

  const probe = async () => {
    if (!provider || !model) return;
    setBusy(true);
    setStatus(t("ai.probing"));
    try {
      const typed = enteredKey(apiKey);
      const current = await persist();
      if (!current?.baseUrl || !current.model) return;
      const sample = await aiProbe(current.baseUrl, current.model, typed || undefined, current.id);
      const text = sample.trim();
      setStatus(text ? t("ai.probe.sample", { text }) : t("ai.probe.ok"));
    } catch (error) {
      setStatus(localizeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="dialog ai-settings"
        role="dialog"
        aria-modal="true"
        aria-label={t("ai.title")}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="dialog__head">
          <h2 className="dialog__title">{t("ai.title")}</h2>
          <button
            type="button"
            className="dialog__close"
            aria-label={t("app.close")}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p className="dialog__message">{t("ai.hint")}</p>

        <section className="ai-settings__complete">
          <h3 className="ai-settings__section">{t("ai.complete.title")}</h3>
          <label className="ai-settings__toggle">
            <input
              type="checkbox"
              checked={completion.enabled}
              onChange={(event) => editCompletion({ enabled: event.target.checked })}
            />
            <span>{t("ai.complete.enable")}</span>
          </label>
          <label className="ai-settings__field">
            <span>{t("ai.complete.model")}</span>
            <select
              className="ai-settings__input"
              value={
                choices.some(
                  (choice) => `${choice.providerId}|${choice.modelId}` === completionValue
                )
                  ? completionValue
                  : ""
              }
              onChange={(event) => {
                const [providerId = "", modelId = ""] = event.target.value.split("|");
                editCompletion({ providerId, modelId });
              }}
            >
              <option value="">{t("ai.complete.modelEmpty")}</option>
              {choices.map((choice) => (
                <option
                  key={`${choice.providerId}|${choice.modelId}`}
                  value={`${choice.providerId}|${choice.modelId}`}
                >
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
          <p className="dialog__message">{t("ai.complete.hint")}</p>
        </section>

        <h3 className="ai-settings__section">{t("ai.providers")}</h3>
        <div className="ai-settings__list" role="listbox" aria-label={t("ai.providers")}>
          {catalog.providers.length === 0 && (
            <p className="ai-settings__empty">{t("ai.provider.empty")}</p>
          )}
          {catalog.providers.map((item) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={item.id === provider?.id}
              className={`ai-settings__model${item.id === provider?.id ? " ai-settings__model--on" : ""}`}
              onClick={() => {
                if (item.id === provider?.id) return;
                forgetKey();
                setStatus(null);
                setCatalog((current) => focusProvider(current, item.id));
              }}
            >
              <span>{item.name.trim() || t("ai.provider.unnamed")}</span>
              <span className="ai-settings__model-id">{item.baseUrl}</span>
            </button>
          ))}
        </div>
        <div className="ai-settings__presets">
          <button
            type="button"
            className="btn"
            onClick={() => {
              forgetKey();
              setCatalog((current) => addProvider(current, t("ai.provider.new")));
            }}
          >
            {t("ai.provider.add")}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!provider}
            onClick={() => {
              if (!provider) return;
              forgetKey();
              setCatalog((current) => removeProvider(current, provider.id));
            }}
          >
            {t("ai.provider.remove")}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              const next = withOllamaPreset(catalog);
              if (next.activeProviderId !== catalog.activeProviderId) forgetKey();
              setCatalog(next);
            }}
          >
            {t("ai.preset.ollama")}
          </button>
        </div>

        <label className="ai-settings__field">
          <span>{t("ai.provider.name")}</span>
          <input
            className="ai-settings__input"
            value={provider?.name ?? ""}
            disabled={!provider}
            onChange={(event) => editProvider({ name: event.target.value })}
          />
        </label>
        <label className="ai-settings__field">
          <span>{t("ai.baseUrl")}</span>
          <input
            className="ai-settings__input"
            value={provider?.baseUrl ?? ""}
            disabled={!provider}
            spellCheck={false}
            autoComplete="off"
            placeholder="https://api.openai.com/v1"
            onChange={(event) => editProvider({ baseUrl: event.target.value })}
          />
        </label>
        <label className="ai-settings__field">
          <span>{t("ai.key")}</span>
          <input
            className="ai-settings__input"
            type={isSavedKeyMask(apiKey) ? "text" : "password"}
            value={apiKey}
            disabled={!provider}
            spellCheck={false}
            autoComplete="off"
            placeholder={hasKey ? t("ai.key.saved") : t("ai.key.placeholder")}
            onChange={(event) => {
              const next = event.target.value;
              setApiKey(isSavedKeyMask(apiKey) ? next.replace(/\*/g, "") : next);
            }}
          />
        </label>

        <h3 className="ai-settings__section">{t("ai.models")}</h3>
        <div className="ai-settings__list" role="listbox" aria-label={t("ai.models")}>
          {!provider && <p className="ai-settings__empty">{t("ai.provider.empty")}</p>}
          {provider && provider.models.length === 0 && (
            <p className="ai-settings__empty">{t("ai.model.empty")}</p>
          )}
          {provider?.models.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="option"
              aria-selected={entry.id === model?.id}
              className={`ai-settings__model${entry.id === model?.id ? " ai-settings__model--on" : ""}`}
              onClick={() => {
                setStatus(null);
                setCatalog((current) => ({ ...current, activeModelId: entry.id }));
              }}
            >
              <span>{entry.name.trim() || entry.model.trim() || t("ai.model.unnamed")}</span>
              {entry.model && entry.model !== entry.name.trim() && (
                <span className="ai-settings__model-id">{entry.model}</span>
              )}
            </button>
          ))}
        </div>
        <div className="ai-settings__presets">
          <button
            type="button"
            className="btn"
            disabled={!provider}
            onClick={() => {
              if (!provider) return;
              setCatalog((current) => addModel(current, provider.id, t("ai.model.new")));
            }}
          >
            {t("ai.model.add")}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!model}
            onClick={() => {
              if (!provider || !model) return;
              setCatalog((current) => removeModel(current, provider.id, model.id));
            }}
          >
            {t("ai.model.remove")}
          </button>
        </div>
        <label className="ai-settings__field">
          <span>{t("ai.model.name")}</span>
          <input
            className="ai-settings__input"
            value={model?.name ?? ""}
            disabled={!model}
            onChange={(event) => editModel({ name: event.target.value })}
          />
        </label>
        <label className="ai-settings__field">
          <span>{t("ai.model.id")}</span>
          <input
            className="ai-settings__input"
            value={model?.model ?? ""}
            disabled={!model}
            spellCheck={false}
            autoComplete="off"
            placeholder="gpt-4o"
            onChange={(event) => editModel({ model: event.target.value })}
          />
        </label>

        {status && (
          <p className="ai-settings__status" role="status">
            {status}
          </p>
        )}
        <div className="dialog__actions">
          <button
            type="button"
            className="btn"
            disabled={busy || !provider || (!hasKey && enteredKey(apiKey) === "")}
            onClick={() => void clearKey()}
          >
            {t("ai.clearKey")}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !ready}
            onClick={() => void probe()}
          >
            {t("ai.probe")}
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy || !provider}>
            {t("ai.save")}
          </button>
        </div>
      </form>
    </div>
  );
}
