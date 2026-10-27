import { useEffect, useRef, useState, type ReactNode } from "react";
import { dismissActiveCompletion } from "../editor/completion";
import { localizeError, setLocale, useI18n, type Locale } from "../i18n";
import {
  aiBoundOrigin,
  aiClearKey,
  aiHasKey,
  aiProbe,
  aiSetKey,
  appInfo,
  isTauri,
} from "../ipc/api";
import { loadDenylistText, saveDenylistText } from "./agentAccess";
import {
  acceptanceRate,
  averageFirstTokenMs,
  failureRate,
  loadAiMetrics,
  resetAiMetrics,
  subscribeAiMetrics,
  type AiMetrics,
} from "./aiMetrics";
import {
  SAVED_KEY_MASK,
  addModel,
  addProvider,
  isSavedKeyMask,
  keepActiveModel,
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
import { endpointOrigin } from "./aiStream";
import {
  completionChoices,
  loadCompletionSettings,
  saveCompletionSettings,
  type CompletionSettings,
} from "./completionSettings";
import { ask } from "./dialogStore";
import { AppLogo } from "./MenuBar";
import { setThemePreference, useThemePreference, type ThemePreference } from "./theme";
import { useWorkspace, type SettingsSection } from "../stores/workspace";

/** A mask of only asterisks means "keep the key already in the keychain". */
function enteredKey(value: string): string {
  const trimmed = value.trim();
  return isSavedKeyMask(trimmed) ? "" : trimmed;
}

const pairOf = (providerId: string, modelId: string) => `${providerId}|${modelId}`;

/** Editor and model settings as a page in the tab bar. Keys stay in the OS keychain. */
export default function SettingsPage() {
  const { t } = useI18n();
  const section = useWorkspace((state) => state.settingsSection);
  const setSection = useWorkspace((state) => state.setSettingsSection);
  const [catalog, setCatalog] = useState<AiCatalog>(loadAiSettings);
  const [version, setVersion] = useState("");
  const [expanded, setExpanded] = useState<string | null>(
    () => loadAiSettings().activeProviderId || null
  );

  useEffect(() => {
    void appInfo()
      .then((info) => setVersion(info.version))
      .catch(() => {});
  }, []);

  const commit = (next: AiCatalog) => {
    saveAiSettings(next);
    setCatalog(next);
  };

  const groups: { label: string; items: { id: SettingsSection; label: string }[] }[] = [
    {
      label: t("settings.group.editor"),
      items: [{ id: "general", label: t("settings.nav.general") }],
    },
    {
      label: t("settings.group.ai"),
      items: [
        { id: "models", label: t("settings.nav.models") },
        { id: "providers", label: t("settings.nav.providers") },
        { id: "access", label: t("settings.nav.access") },
        { id: "usage", label: t("settings.nav.usage") },
      ],
    },
  ];

  return (
    <div className="settings">
      <aside className="settings__side">
        <div className="settings__brand">
          <AppLogo className="settings__logo" />
          <div>
            <div className="settings__app">6byte</div>
            {version && <div className="settings__version">{t("about.version", { version })}</div>}
          </div>
        </div>
        <nav className="settings__nav" aria-label={t("settings.title")}>
          {groups.map((group) => (
            <div key={group.label} className="settings__nav-group">
              <div className="settings__nav-label">{group.label}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`settings__nav-item${section === item.id ? " settings__nav-item--on" : ""}`}
                  aria-current={section === item.id ? "page" : undefined}
                  onClick={() => setSection(item.id)}
                >
                  <NavIcon kind={item.id} />
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <main className="settings__main">
        {section === "general" && <GeneralSection />}
        {section === "models" && (
          <ModelsSection
            catalog={catalog}
            commit={commit}
            onGoProviders={() => setSection("providers")}
          />
        )}
        {section === "providers" && (
          <ProvidersSection
            catalog={catalog}
            commit={commit}
            expanded={expanded}
            setExpanded={setExpanded}
          />
        )}
        {section === "access" && <AccessSection />}
        {section === "usage" && <UsageSection />}
      </main>
    </div>
  );
}

function Header({ title, sub, actions }: { title: string; sub: string; actions?: ReactNode }) {
  return (
    <header className="settings__header">
      <div>
        <h1 className="settings__title">{title}</h1>
        <p className="settings__sub">{sub}</p>
      </div>
      {actions && <div className="settings__header-actions">{actions}</div>}
    </header>
  );
}

function Row({ title, hint, children }: { title: ReactNode; hint?: string; children?: ReactNode }) {
  return (
    <div className="settings__row">
      <div className="settings__row-text">
        <div className="settings__row-title">{title}</div>
        {hint && <div className="settings__row-hint">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Switch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange(next: boolean): void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`settings__switch${checked ? " settings__switch--on" : ""}`}
      onClick={() => onChange(!checked)}
    />
  );
}

function GeneralSection() {
  const { t, locale } = useI18n();
  const preference = useThemePreference();
  const themes: { id: ThemePreference; label: string }[] = [
    { id: "light", label: t("menu.light") },
    { id: "dark", label: t("menu.dark") },
    { id: "system", label: t("menu.system") },
  ];

  return (
    <>
      <Header title={t("settings.nav.general")} sub={t("settings.general.sub")} />
      <h2 className="settings__section">{t("settings.general.appearance")}</h2>
      <div className="settings__card">
        <Row title={t("menu.theme")} hint={t("settings.general.themeHint")}>
          <div className="settings__segmented" role="radiogroup" aria-label={t("menu.theme")}>
            {themes.map((theme) => (
              <button
                key={theme.id}
                type="button"
                role="radio"
                aria-checked={theme.id === preference}
                className={`settings__segment${theme.id === preference ? " settings__segment--on" : ""}`}
                onClick={() => setThemePreference(theme.id)}
              >
                {theme.label}
              </button>
            ))}
          </div>
        </Row>
        <Row title={t("menu.language")} hint={t("settings.general.languageHint")}>
          <select
            className="settings__select"
            aria-label={t("menu.language")}
            value={locale}
            onChange={(event) => setLocale(event.target.value as Locale)}
          >
            <option value="zh">{t("menu.langZh")}</option>
            <option value="en">{t("menu.langEn")}</option>
          </select>
        </Row>
      </div>
    </>
  );
}

function ModelsSection({
  catalog,
  commit,
  onGoProviders,
}: {
  catalog: AiCatalog;
  commit(next: AiCatalog): void;
  onGoProviders(): void;
}) {
  const { t } = useI18n();
  const [completion, setCompletion] = useState<CompletionSettings>(loadCompletionSettings);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState(catalog.activeProviderId || catalog.providers[0]?.id || "");
  const [editing, setEditing] = useState<{ id: string; name: string; model: string } | null>(null);

  const chatValue = pairOf(catalog.activeProviderId, catalog.activeModelId);
  const chatChoices = completionChoices(catalog, {
    providerId: catalog.activeProviderId,
    modelId: catalog.activeModelId,
  });
  const completionValue = pairOf(completion.providerId, completion.modelId);
  const completeChoices = completionChoices(catalog, completion);
  const targetProvider =
    catalog.providers.find((provider) => provider.id === target) ?? catalog.providers[0];
  const typed = query.trim();
  const needle = typed.toLowerCase();
  const canAdd =
    Boolean(targetProvider && typed) &&
    !targetProvider?.models.some((model) => model.model === typed);

  const editCompletion = (patch: Partial<CompletionSettings>) => {
    const next = { ...completion, ...patch };
    setCompletion(next);
    saveCompletionSettings(next);
    if (!next.enabled) dismissActiveCompletion();
  };

  const add = () => {
    if (!canAdd || !targetProvider) return;
    commit(keepActiveModel(catalog, addModel(catalog, targetProvider.id, typed, typed)));
    setQuery("");
  };

  const finishEdit = (provider: Provider, model: ProviderModel) => {
    if (!editing) return;
    const apiModel = editing.model.trim();
    commit(
      updateModel(catalog, provider.id, {
        ...model,
        name: editing.name.trim() || apiModel || t("ai.model.unnamed"),
        model: apiModel,
      })
    );
    setEditing(null);
  };

  const matches = (model: ProviderModel) =>
    !needle ||
    model.name.toLowerCase().includes(needle) ||
    model.model.toLowerCase().includes(needle);
  const anyMatch = catalog.providers.some((provider) => provider.models.some(matches));

  return (
    <>
      <Header title={t("settings.nav.models")} sub={t("settings.models.sub")} />

      <h2 className="settings__section">{t("settings.models.task")}</h2>
      <div className="settings__card">
        <Row title={t("settings.models.chat")} hint={t("settings.models.chatHint")}>
          <select
            className="settings__select"
            aria-label={t("settings.models.chat")}
            value={
              chatChoices.some((c) => pairOf(c.providerId, c.modelId) === chatValue)
                ? chatValue
                : ""
            }
            onChange={(event) => {
              const [providerId = "", modelId = ""] = event.target.value.split("|");
              if (!providerId) return;
              commit({ ...catalog, activeProviderId: providerId, activeModelId: modelId });
            }}
          >
            <option value="">{t("settings.models.chatEmpty")}</option>
            {chatChoices.map((choice) => (
              <option
                key={pairOf(choice.providerId, choice.modelId)}
                value={pairOf(choice.providerId, choice.modelId)}
              >
                {choice.label}
              </option>
            ))}
          </select>
        </Row>
        <Row title={t("ai.complete.title")} hint={t("settings.models.completeHint")}>
          <Switch
            checked={completion.enabled}
            label={t("ai.complete.enable")}
            onChange={(enabled) => editCompletion({ enabled })}
          />
        </Row>
        <Row title={t("ai.complete.model")} hint={t("settings.models.completeModelHint")}>
          <select
            className="settings__select"
            aria-label={t("ai.complete.model")}
            value={
              completeChoices.some((c) => pairOf(c.providerId, c.modelId) === completionValue)
                ? completionValue
                : ""
            }
            onChange={(event) => {
              const [providerId = "", modelId = ""] = event.target.value.split("|");
              editCompletion({ providerId, modelId });
            }}
          >
            <option value="">{t("ai.complete.modelEmpty")}</option>
            {completeChoices.map((choice) => (
              <option
                key={pairOf(choice.providerId, choice.modelId)}
                value={pairOf(choice.providerId, choice.modelId)}
              >
                {choice.label}
              </option>
            ))}
          </select>
        </Row>
      </div>

      <h2 className="settings__section">{t("settings.models.all")}</h2>
      <div className="settings__card">
        {catalog.providers.length === 0 ? (
          <div className="settings__empty">
            <span>{t("ai.provider.empty")}</span>
            <button type="button" className="btn" onClick={onGoProviders}>
              {t("settings.models.goProviders")}
            </button>
          </div>
        ) : (
          <>
            <form
              className="settings__search"
              onSubmit={(event) => {
                event.preventDefault();
                add();
              }}
            >
              <input
                className="settings__input"
                value={query}
                spellCheck={false}
                autoComplete="off"
                placeholder={t("settings.models.search")}
                aria-label={t("settings.models.search")}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  add();
                }}
              />
              {catalog.providers.length > 1 && (
                <select
                  className="settings__select"
                  aria-label={t("settings.models.addTo")}
                  value={targetProvider?.id ?? ""}
                  onChange={(event) => setTarget(event.target.value)}
                >
                  {catalog.providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name || t("ai.provider.unnamed")}
                    </option>
                  ))}
                </select>
              )}
              <button type="submit" className="btn" disabled={!canAdd}>
                {t("settings.models.add")}
              </button>
            </form>
            {!anyMatch && typed && (
              <p className="settings__empty">{t("settings.models.noMatch", { query: typed })}</p>
            )}
            {catalog.providers.map((provider) => {
              const models = provider.models.filter(matches);
              if (needle && models.length === 0) return null;
              return (
                <div key={provider.id} className="settings__group">
                  <div className="settings__group-head">
                    <span>{provider.name || t("ai.provider.unnamed")}</span>
                    <span className="settings__mono">{provider.baseUrl}</span>
                  </div>
                  {models.length === 0 && <p className="settings__empty">{t("ai.model.empty")}</p>}
                  {models.map((model) =>
                    editing?.id === model.id ? (
                      <form
                        key={model.id}
                        className="settings__row settings__row--edit"
                        onSubmit={(event) => {
                          event.preventDefault();
                          finishEdit(provider, model);
                        }}
                      >
                        <input
                          className="settings__input"
                          value={editing.name}
                          aria-label={t("ai.model.name")}
                          placeholder={t("ai.model.name")}
                          autoFocus
                          onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                        />
                        <input
                          className="settings__input settings__mono"
                          value={editing.model}
                          aria-label={t("ai.model.id")}
                          placeholder={t("ai.model.id")}
                          spellCheck={false}
                          onChange={(event) =>
                            setEditing({ ...editing, model: event.target.value })
                          }
                        />
                        <button type="submit" className="btn btn--primary">
                          {t("settings.models.done")}
                        </button>
                      </form>
                    ) : (
                      <div key={model.id} className="settings__row settings__model">
                        <div className="settings__row-title">
                          {model.name || model.model || t("ai.model.unnamed")}
                          {model.model && model.model !== model.name && (
                            <span className="settings__mono settings__model-id">{model.model}</span>
                          )}
                          {pairOf(provider.id, model.id) === chatValue && (
                            <span className="settings__tag">{t("settings.models.tagChat")}</span>
                          )}
                          {pairOf(provider.id, model.id) === completionValue && (
                            <span className="settings__tag">
                              {t("settings.models.tagComplete")}
                            </span>
                          )}
                        </div>
                        <div className="settings__model-actions">
                          <button
                            type="button"
                            className="settings__link"
                            onClick={() =>
                              setEditing({ id: model.id, name: model.name, model: model.model })
                            }
                          >
                            {t("settings.models.edit")}
                          </button>
                          <button
                            type="button"
                            className="settings__link settings__link--danger"
                            onClick={() => commit(removeModel(catalog, provider.id, model.id))}
                          >
                            {t("settings.models.remove")}
                          </button>
                          <Switch
                            checked={model.enabled}
                            label={t("settings.models.enabled")}
                            onChange={(enabled) =>
                              commit(updateModel(catalog, provider.id, { ...model, enabled }))
                            }
                          />
                        </div>
                      </div>
                    )
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </>
  );
}

function ProvidersSection({
  catalog,
  commit,
  expanded,
  setExpanded,
}: {
  catalog: AiCatalog;
  commit(next: AiCatalog): void;
  expanded: string | null;
  setExpanded(id: string | null): void;
}) {
  const { t } = useI18n();

  /** Cards save after awaits, so they merge into the stored catalog rather than a render snapshot. */
  const latest = () => loadAiSettings();

  return (
    <>
      <Header
        title={t("settings.nav.providers")}
        sub={t("settings.providers.sub")}
        actions={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => {
                const preset = withOllamaPreset(catalog);
                commit(keepActiveModel(catalog, preset));
                setExpanded(preset.activeProviderId || null);
              }}
            >
              {t("ai.preset.ollama")}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                const next = keepActiveModel(catalog, addProvider(catalog, t("ai.provider.new")));
                commit(next);
                setExpanded(next.providers[next.providers.length - 1]?.id ?? null);
              }}
            >
              {t("ai.provider.add")}
            </button>
          </>
        }
      />
      {catalog.providers.length === 0 && (
        <div className="settings__card">
          <p className="settings__empty">{t("ai.provider.empty")}</p>
        </div>
      )}
      {catalog.providers.map((provider) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          probeModel={probeModelFor(catalog, provider)}
          open={expanded === provider.id}
          onToggle={() => setExpanded(expanded === provider.id ? null : provider.id)}
          onSave={(next) => commit(updateProvider(latest(), next))}
          onRemove={() => commit(removeProvider(latest(), provider.id))}
        />
      ))}
    </>
  );
}

/** The chat model when it belongs to `provider`, else its first enabled model. */
function probeModelFor(catalog: AiCatalog, provider: Provider): string {
  const usable = provider.models.filter((model) => model.model.trim());
  const active =
    catalog.activeProviderId === provider.id
      ? usable.find((model) => model.id === catalog.activeModelId)
      : undefined;
  return (active ?? usable.find((model) => model.enabled) ?? usable[0])?.model.trim() ?? "";
}

function ProviderCard({
  provider,
  probeModel,
  open,
  onToggle,
  onSave,
  onRemove,
}: {
  provider: Provider;
  probeModel: string;
  open: boolean;
  onToggle(): void;
  onSave(next: Provider): void;
  onRemove(): void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const boundOrigin = useRef<string | null>(null);
  const storedKey = useRef(false);
  const keyLoaded = useRef(false);
  const dirty = name !== provider.name || baseUrl !== provider.baseUrl || enteredKey(apiKey) !== "";

  useEffect(() => {
    if (!isTauri) return;
    let cancel = false;
    void aiHasKey(provider.id)
      .then(async (stored) => {
        if (cancel) return;
        setHasKey(stored);
        storedKey.current = stored;
        boundOrigin.current = stored ? await aiBoundOrigin(provider.id) : null;
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
  }, [provider.id]);

  const confirmHostChange = async (url: string): Promise<"ok" | "cleared" | "cancel"> => {
    if (!isTauri || enteredKey(apiKey)) return "ok";
    if (!keyLoaded.current) {
      const stored = await aiHasKey(provider.id);
      storedKey.current = stored;
      boundOrigin.current = stored ? await aiBoundOrigin(provider.id) : null;
      keyLoaded.current = true;
      setHasKey(stored);
    }
    if (!storedKey.current) return "ok";
    const nextOrigin = endpointOrigin(url);
    if (!nextOrigin || boundOrigin.current === nextOrigin) return "ok";
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

  /** Saves the card. Returns null when the user cancelled a host change. */
  const persist = async (): Promise<{ hostChange: "ok" | "cleared"; typed: string } | null> => {
    const url = baseUrl.trim();
    const hostChange = await confirmHostChange(url);
    if (hostChange === "cancel") return null;
    const typed = enteredKey(apiKey);
    const next: Provider = {
      ...provider,
      name: name.trim() || provider.models[0]?.model.trim() || t("ai.provider.unnamed"),
      baseUrl: url,
    };
    onSave(next);
    setName(next.name);
    setBaseUrl(next.baseUrl);
    if (typed && isTauri) {
      await aiSetKey(typed, next.id, next.baseUrl);
      boundOrigin.current = endpointOrigin(next.baseUrl);
      storedKey.current = true;
      keyLoaded.current = true;
      setApiKey(SAVED_KEY_MASK);
      setHasKey(true);
    }
    return { hostChange, typed };
  };

  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const result = await persist();
      if (!result) return;
      setStatus(
        result.hostChange === "cleared"
          ? t("ai.hostChanged.cleared")
          : result.typed
            ? t("ai.saved")
            : t("ai.savedPublic")
      );
    } catch (error) {
      setStatus(localizeError(error));
    } finally {
      setBusy(false);
    }
  };

  const probe = async () => {
    if (!probeModel) return;
    setBusy(true);
    setStatus(t("ai.probing"));
    try {
      const result = await persist();
      if (!result) {
        setStatus(null);
        return;
      }
      const sample = await aiProbe(
        baseUrl.trim(),
        probeModel,
        result.typed || undefined,
        provider.id
      );
      const text = sample.trim();
      setStatus(text ? t("ai.probe.sample", { text }) : t("ai.probe.ok"));
    } catch (error) {
      setStatus(localizeError(error));
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async () => {
    setBusy(true);
    setStatus(null);
    try {
      if (hasKey || isSavedKeyMask(apiKey)) await aiClearKey(provider.id);
      setApiKey("");
      setHasKey(false);
      storedKey.current = false;
      boundOrigin.current = null;
      setStatus(t("ai.cleared"));
    } catch (error) {
      setStatus(localizeError(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const choice = await ask({
      title: t("ai.provider.remove"),
      message: t("settings.providers.removeMessage", {
        name: provider.name || t("ai.provider.unnamed"),
        count: provider.models.length,
      }),
      buttons: [
        { label: t("dialog.cancel"), value: "cancel" },
        { label: t("settings.models.remove"), value: "confirm", variant: "danger" },
      ],
    });
    if (choice !== "confirm") return;
    try {
      if (isTauri) await aiClearKey(provider.id);
    } catch {
      // The catalog entry still goes; a stale keychain item is unreachable without its id.
    }
    onRemove();
  };

  return (
    <div className="settings__card">
      <button
        type="button"
        className="settings__provider-head"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span
          className={`settings__chevron${open ? " settings__chevron--open" : ""}`}
          aria-hidden="true"
        >
          ›
        </span>
        <span className="settings__provider-name">{provider.name || t("ai.provider.unnamed")}</span>
        <span className="settings__mono settings__provider-url">{provider.baseUrl}</span>
        <span className="settings__row-hint">
          {t("settings.providers.count", { count: provider.models.length })}
        </span>
      </button>
      {open && (
        <form
          className="settings__provider-body"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="settings__field">
            <span>{t("ai.provider.name")}</span>
            <input
              className="settings__input"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="settings__field">
            <span>{t("ai.baseUrl")}</span>
            <input
              className="settings__input settings__mono"
              value={baseUrl}
              spellCheck={false}
              autoComplete="off"
              placeholder="https://api.openai.com/v1"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <label className="settings__field">
            <span>{t("ai.key")}</span>
            <input
              className="settings__input settings__mono"
              type={isSavedKeyMask(apiKey) ? "text" : "password"}
              value={apiKey}
              spellCheck={false}
              autoComplete="off"
              placeholder={hasKey ? t("ai.key.saved") : t("ai.key.placeholder")}
              onChange={(event) => {
                const next = event.target.value;
                setApiKey(isSavedKeyMask(apiKey) ? next.replace(/\*/g, "") : next);
              }}
            />
          </label>
          {status && (
            <p className="settings__status" role="status">
              {status}
            </p>
          )}
          <div className="settings__provider-actions">
            <button
              type="button"
              className="btn btn--danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              {t("ai.provider.remove")}
            </button>
            <span className="settings__spacer" />
            <button
              type="button"
              className="btn"
              disabled={busy || (!hasKey && enteredKey(apiKey) === "")}
              onClick={() => void clearKey()}
            >
              {t("ai.clearKey")}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !baseUrl.trim() || !probeModel}
              title={probeModel ? undefined : t("ai.model.empty")}
              onClick={() => void probe()}
            >
              {t("ai.probe")}
            </button>
            <button type="submit" className="btn btn--primary" disabled={busy || !dirty}>
              {t("ai.save")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function AccessSection() {
  const { t } = useI18n();
  const [denyText, setDenyText] = useState(loadDenylistText);
  return (
    <>
      <Header title={t("settings.nav.access")} sub={t("settings.access.sub")} />
      <div className="settings__card">
        <Row title={t("ai.deny.title")} hint={t("ai.deny.hint")} />
        <textarea
          className="settings__input settings__textarea"
          rows={8}
          spellCheck={false}
          aria-label={t("ai.deny.title")}
          value={denyText}
          onChange={(event) => {
            setDenyText(event.target.value);
            saveDenylistText(event.target.value);
          }}
        />
      </div>
    </>
  );
}

function total(
  metrics: AiMetrics,
  field: "started" | "succeeded" | "failed" | "cancelled"
): number {
  return Object.values(metrics.requests).reduce((sum, item) => sum + item[field], 0);
}

function UsageSection() {
  const { t } = useI18n();
  const [metrics, setMetrics] = useState<AiMetrics>(loadAiMetrics);
  useEffect(() => subscribeAiMetrics(() => setMetrics(loadAiMetrics())), []);

  const requestTotal = total(metrics, "started");
  const succeeded = total(metrics, "succeeded");
  const failed = total(metrics, "failed");
  const cancelled = total(metrics, "cancelled");
  const summary = {
    started: requestTotal,
    succeeded,
    failed,
    cancelled,
    firstTokenCount: Object.values(metrics.requests).reduce(
      (sum, item) => sum + item.firstTokenCount,
      0
    ),
    firstTokenMs: Object.values(metrics.requests).reduce((sum, item) => sum + item.firstTokenMs, 0),
  };
  const failure = failureRate(summary);
  const firstToken = averageFirstTokenMs(summary);
  const rewrite = acceptanceRate(metrics.offers.rewrite);
  const complete = acceptanceRate(metrics.offers.completion);
  const percent = (value: number | null) =>
    value === null
      ? t("ai.metrics.none")
      : t("ai.metrics.percent", { percent: Math.round(value * 100) });

  const stats: { label: string; value: string; detail?: string }[] = [
    {
      label: t("ai.metrics.tokens"),
      value: t("ai.metrics.tokensValue", {
        prompt: metrics.promptTokens,
        completion: metrics.completionTokens,
      }),
    },
    {
      label: t("ai.metrics.requests"),
      value: String(requestTotal),
      detail: t("ai.metrics.requestsValue", { total: requestTotal, succeeded, failed, cancelled }),
    },
    { label: t("ai.metrics.failure"), value: percent(failure) },
    {
      label: t("ai.metrics.firstToken"),
      value:
        firstToken === null
          ? t("ai.metrics.none")
          : t("ai.metrics.latency", { milliseconds: firstToken }),
    },
    {
      label: t("ai.metrics.rewriteAcceptance"),
      value: percent(rewrite),
      detail: `${metrics.offers.rewrite.accepted} / ${metrics.offers.rewrite.shown}`,
    },
    {
      label: t("ai.metrics.completionAcceptance"),
      value: percent(complete),
      detail: `${metrics.offers.completion.accepted} / ${metrics.offers.completion.shown}`,
    },
  ];

  return (
    <>
      <Header
        title={t("settings.nav.usage")}
        sub={t("ai.metrics.hint", { reports: metrics.usageReports })}
        actions={
          <button
            type="button"
            className="btn"
            onClick={resetAiMetrics}
            disabled={requestTotal === 0}
          >
            {t("ai.metrics.reset")}
          </button>
        }
      />
      <div className="settings__card settings__stats">
        {stats.map((stat) => (
          <div key={stat.label} className="settings__stat">
            <div className="settings__row-hint">{stat.label}</div>
            <div className="settings__stat-value">{stat.value}</div>
            {stat.detail && <div className="settings__row-hint">{stat.detail}</div>}
          </div>
        ))}
      </div>
    </>
  );
}

function NavIcon({ kind }: { kind: SettingsSection }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "general" && (
        <>
          <path d="M2.5 4.5h7M12.5 4.5h1M2.5 11.5h1M6.5 11.5h7" />
          <circle cx="11" cy="4.5" r="1.5" />
          <circle cx="5" cy="11.5" r="1.5" />
        </>
      )}
      {kind === "models" && (
        <>
          <path d="M8 1.8l5.5 3.1v6.2L8 14.2l-5.5-3.1V4.9z" />
          <path d="M2.5 4.9L8 8l5.5-3.1M8 8v6.2" />
        </>
      )}
      {kind === "providers" && (
        <>
          <rect x="2" y="2.5" width="12" height="4" rx="1" />
          <rect x="2" y="9.5" width="12" height="4" rx="1" />
          <path d="M4.5 4.5h.01M4.5 11.5h.01" />
        </>
      )}
      {kind === "access" && <path d="M8 1.8l5 2v4c0 3-2.2 5.2-5 6.4-2.8-1.2-5-3.4-5-6.4v-4z" />}
      {kind === "usage" && <path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5" />}
    </svg>
  );
}
