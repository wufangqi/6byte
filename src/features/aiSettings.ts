/** Non-secret provider and model catalog. API keys never go through this module. */

export const AI_SETTINGS_KEY = "ainative.ai";

/** Shown in the key field once a key is stored. It is not itself a key. */
export const SAVED_KEY_MASK = "*****";

export function isSavedKeyMask(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && /^\*+$/.test(trimmed);
}

/** One model offered by a provider. The id is local; `model` is what the API expects. */
export interface ProviderModel {
  id: string;
  name: string;
  model: string;
  /** Disabled models stay configured but are left out of model pickers. */
  enabled: boolean;
}

/** A service endpoint. Its API key lives in the keychain under `id`, shared by every model. */
export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  models: ProviderModel[];
}

export interface AiCatalog {
  activeProviderId: string;
  activeModelId: string;
  providers: Provider[];
}

/** What a request needs. `id` is the provider id used as the keychain account. */
export interface ActiveEndpoint {
  id: string;
  baseUrl: string;
  model: string;
}

export const EMPTY_AI_CATALOG: AiCatalog = {
  activeProviderId: "",
  activeModelId: "",
  providers: [],
};

/** The original single-slot install. Its key stays in the legacy keychain account. */
export const LEGACY_PROFILE_ID = "default";

const OLLAMA_URL = "http://127.0.0.1:11434/v1";
const OLLAMA_MODEL = "llama3.2";

export function newProfileId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `m${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function activeProvider(catalog: AiCatalog): Provider | null {
  return (
    catalog.providers.find((provider) => provider.id === catalog.activeProviderId) ??
    catalog.providers[0] ??
    null
  );
}

export function activeModelEntry(catalog: AiCatalog): ProviderModel | null {
  const provider = activeProvider(catalog);
  if (!provider) return null;
  return (
    provider.models.find((model) => model.id === catalog.activeModelId) ??
    provider.models[0] ??
    null
  );
}

export function activeModel(catalog: AiCatalog): ActiveEndpoint | null {
  const provider = activeProvider(catalog);
  if (!provider) return null;
  const model = activeModelEntry(catalog);
  return { id: provider.id, baseUrl: provider.baseUrl, model: model?.model ?? "" };
}

function cleanModel(value: unknown): ProviderModel | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { id?: unknown; name?: unknown; model?: unknown; enabled?: unknown };
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return null;
  const model = typeof record.model === "string" ? record.model.trim() : "";
  const name =
    typeof record.name === "string" && record.name.trim() ? record.name.trim() : model || "模型";
  return { id, name, model, enabled: record.enabled !== false };
}

function cleanProvider(value: unknown): Provider | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { id?: unknown; name?: unknown; baseUrl?: unknown; models?: unknown };
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return null;
  const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
  const models: ProviderModel[] = [];
  if (Array.isArray(record.models)) {
    for (const item of record.models) {
      const model = cleanModel(item);
      if (model && !models.some((existing) => existing.id === model.id)) models.push(model);
    }
  }
  const name =
    typeof record.name === "string" && record.name.trim()
      ? record.name.trim()
      : models[0]?.name || "服务商";
  return { id, name, baseUrl, models };
}

/** A flat `{ id, name, baseUrl, model }` profile becomes one provider with one model. */
function migrateProfile(value: unknown, fallbackId: string): Provider | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { id?: unknown; name?: unknown; baseUrl?: unknown; model?: unknown };
  const model = typeof record.model === "string" ? record.model.trim() : "";
  const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : fallbackId;
  if (!id || (!baseUrl && !model)) return null;
  const name =
    typeof record.name === "string" && record.name.trim() ? record.name.trim() : model || "服务商";
  const models: ProviderModel[] = model
    ? [{ id: `${id}-model`, name: name || model, model, enabled: true }]
    : [];
  return { id, name, baseUrl, models };
}

function finish(
  providers: Provider[],
  requestedProvider: string,
  requestedModel: string
): AiCatalog {
  const unique: Provider[] = [];
  for (const provider of providers) {
    if (!unique.some((item) => item.id === provider.id)) unique.push(provider);
  }
  const activeProviderId = unique.some((provider) => provider.id === requestedProvider)
    ? requestedProvider
    : (unique[0]?.id ?? "");
  const provider = unique.find((item) => item.id === activeProviderId);
  const activeModelId = provider?.models.some((model) => model.id === requestedModel)
    ? requestedModel
    : (provider?.models[0]?.id ?? "");
  return { activeProviderId, activeModelId, providers: unique };
}

export function parseAiSettings(raw: string | null | undefined): AiCatalog {
  if (!raw) return EMPTY_AI_CATALOG;
  try {
    const value = JSON.parse(raw) as {
      baseUrl?: unknown;
      model?: unknown;
      activeId?: unknown;
      activeProviderId?: unknown;
      activeModelId?: unknown;
      profiles?: unknown;
      providers?: unknown;
    };
    if (Array.isArray(value.providers)) {
      const providers = value.providers
        .map((provider) => cleanProvider(provider))
        .filter((provider): provider is Provider => provider !== null);
      return finish(
        providers,
        typeof value.activeProviderId === "string" ? value.activeProviderId : "",
        typeof value.activeModelId === "string" ? value.activeModelId : ""
      );
    }
    if (Array.isArray(value.profiles)) {
      const providers = value.profiles
        .map((profile, index) => migrateProfile(profile, index === 0 ? LEGACY_PROFILE_ID : ""))
        .filter((provider): provider is Provider => provider !== null);
      return finish(providers, typeof value.activeId === "string" ? value.activeId : "", "");
    }
    const legacy = migrateProfile(
      { id: LEGACY_PROFILE_ID, baseUrl: value.baseUrl, model: value.model },
      LEGACY_PROFILE_ID
    );
    if (!legacy) return EMPTY_AI_CATALOG;
    return finish([legacy], legacy.id, "");
  } catch {
    return EMPTY_AI_CATALOG;
  }
}

/** Public fields only. A stray `apiKey` on a provider or model is dropped. */
export function serializeAiSettings(catalog: AiCatalog): string {
  return JSON.stringify({
    activeProviderId: catalog.activeProviderId,
    activeModelId: catalog.activeModelId,
    providers: catalog.providers.map((provider) => ({
      id: provider.id,
      name: provider.name.trim() || provider.models[0]?.model.trim() || "服务商",
      baseUrl: provider.baseUrl.trim(),
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.name.trim() || model.model.trim() || "模型",
        model: model.model.trim(),
        enabled: model.enabled,
      })),
    })),
  });
}

export function loadAiSettings(): AiCatalog {
  try {
    return parseAiSettings(localStorage.getItem(AI_SETTINGS_KEY));
  } catch {
    return EMPTY_AI_CATALOG;
  }
}

export function saveAiSettings(catalog: AiCatalog): void {
  localStorage.setItem(AI_SETTINGS_KEY, serializeAiSettings(catalog));
}

export function focusProvider(catalog: AiCatalog, id: string): AiCatalog {
  const provider = catalog.providers.find((item) => item.id === id);
  if (!provider) return catalog;
  const activeModelId = provider.models.some((model) => model.id === catalog.activeModelId)
    ? catalog.activeModelId
    : (provider.models[0]?.id ?? "");
  return { ...catalog, activeProviderId: id, activeModelId };
}

export function addProvider(catalog: AiCatalog, name = "新服务商"): AiCatalog {
  const provider: Provider = { id: newProfileId(), name, baseUrl: "", models: [] };
  return {
    ...catalog,
    activeProviderId: provider.id,
    activeModelId: "",
    providers: [...catalog.providers, provider],
  };
}

export function removeProvider(catalog: AiCatalog, id: string): AiCatalog {
  const providers = catalog.providers.filter((provider) => provider.id !== id);
  if (catalog.activeProviderId !== id) return { ...catalog, providers };
  const next = providers[0];
  return {
    providers,
    activeProviderId: next?.id ?? "",
    activeModelId: next?.models[0]?.id ?? "",
  };
}

export function updateProvider(catalog: AiCatalog, provider: Provider): AiCatalog {
  return {
    ...catalog,
    providers: catalog.providers.map((item) => (item.id === provider.id ? provider : item)),
  };
}

export function addModel(
  catalog: AiCatalog,
  providerId: string,
  name = "新模型",
  apiModel = ""
): AiCatalog {
  const model: ProviderModel = { id: newProfileId(), name, model: apiModel, enabled: true };
  let added = false;
  const providers = catalog.providers.map((provider) => {
    if (provider.id !== providerId) return provider;
    added = true;
    return { ...provider, models: [...provider.models, model] };
  });
  if (!added) return catalog;
  return { ...catalog, providers, activeProviderId: providerId, activeModelId: model.id };
}

export function removeModel(catalog: AiCatalog, providerId: string, modelId: string): AiCatalog {
  const providers = catalog.providers.map((provider) => {
    if (provider.id !== providerId) return provider;
    return { ...provider, models: provider.models.filter((model) => model.id !== modelId) };
  });
  const provider = providers.find((item) => item.id === providerId);
  const activeModelId =
    catalog.activeProviderId === providerId && catalog.activeModelId === modelId
      ? (provider?.models[0]?.id ?? "")
      : catalog.activeModelId;
  return { ...catalog, providers, activeModelId };
}

export function updateModel(
  catalog: AiCatalog,
  providerId: string,
  model: ProviderModel
): AiCatalog {
  return {
    ...catalog,
    providers: catalog.providers.map((provider) =>
      provider.id === providerId
        ? {
            ...provider,
            models: provider.models.map((item) => (item.id === model.id ? model : item)),
          }
        : provider
    ),
  };
}

/** Keep the previous chat model selected after `next` added a provider or model. */
export function keepActiveModel(previous: AiCatalog, next: AiCatalog): AiCatalog {
  const provider = next.providers.find((item) => item.id === previous.activeProviderId);
  if (!provider?.models.some((model) => model.id === previous.activeModelId)) return next;
  return {
    ...next,
    activeProviderId: previous.activeProviderId,
    activeModelId: previous.activeModelId,
  };
}

/** Adds local Ollama, or selects the provider that already uses that address. */
export function withOllamaPreset(catalog: AiCatalog): AiCatalog {
  const existing = catalog.providers.find((provider) => provider.baseUrl.trim() === OLLAMA_URL);
  if (existing) {
    const model = existing.models.find((item) => item.model.trim() === OLLAMA_MODEL);
    if (model) return { ...catalog, activeProviderId: existing.id, activeModelId: model.id };
    return addModel(
      { ...catalog, activeProviderId: existing.id },
      existing.id,
      OLLAMA_MODEL,
      OLLAMA_MODEL
    );
  }
  const providerId = newProfileId();
  const modelId = newProfileId();
  const provider: Provider = {
    id: providerId,
    name: "本地 Ollama",
    baseUrl: OLLAMA_URL,
    models: [{ id: modelId, name: OLLAMA_MODEL, model: OLLAMA_MODEL, enabled: true }],
  };
  return {
    activeProviderId: providerId,
    activeModelId: modelId,
    providers: [...catalog.providers, provider],
  };
}
