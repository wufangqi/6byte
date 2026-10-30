import { loadAiSettings, type ActiveEndpoint, type AiCatalog } from "./aiSettings";
import { watchStorageKey } from "../lib/storageSync";

/** Separate from the rewrite catalog so the completion model can differ. */
export const COMPLETION_KEY = "ainative.complete";

/** Pause before a completion request. The settings page edits this in seconds. */
export const COMPLETION_DELAY_DEFAULT = 500;
export const COMPLETION_DELAY_MIN = 100;
export const COMPLETION_DELAY_MAX = 5_000;

export interface CompletionSettings {
  /** Master switch. Off means the editor never asks the model to complete. */
  enabled: boolean;
  providerId: string;
  modelId: string;
  /** Milliseconds to wait after the last keystroke. */
  delayMs: number;
}

export const COMPLETION_OFF: CompletionSettings = {
  enabled: false,
  providerId: "",
  modelId: "",
  delayMs: COMPLETION_DELAY_DEFAULT,
};

export function cleanCompletionDelay(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return COMPLETION_DELAY_DEFAULT;
  return Math.max(COMPLETION_DELAY_MIN, Math.min(COMPLETION_DELAY_MAX, Math.round(number)));
}

const listeners = new Set<() => void>();
let unwatchStorage: (() => void) | null = null;

function watchCompletionStorage(): void {
  unwatchStorage ??= watchStorageKey(COMPLETION_KEY, () => {
    listeners.forEach((listener) => listener());
  });
}

export function subscribeCompletion(listener: () => void): () => void {
  watchCompletionStorage();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function parseCompletionSettings(raw: string | null | undefined): CompletionSettings {
  if (!raw) return COMPLETION_OFF;
  try {
    const value = JSON.parse(raw) as {
      enabled?: unknown;
      providerId?: unknown;
      modelId?: unknown;
      delayMs?: unknown;
    };
    return {
      enabled: value.enabled === true,
      providerId: typeof value.providerId === "string" ? value.providerId : "",
      modelId: typeof value.modelId === "string" ? value.modelId : "",
      delayMs: cleanCompletionDelay(value.delayMs),
    };
  } catch {
    return COMPLETION_OFF;
  }
}

export function loadCompletionSettings(): CompletionSettings {
  try {
    return parseCompletionSettings(localStorage.getItem(COMPLETION_KEY));
  } catch {
    return COMPLETION_OFF;
  }
}

export function saveCompletionSettings(settings: CompletionSettings): void {
  localStorage.setItem(
    COMPLETION_KEY,
    JSON.stringify({
      enabled: settings.enabled,
      providerId: settings.providerId,
      modelId: settings.modelId,
      delayMs: cleanCompletionDelay(settings.delayMs),
    })
  );
  listeners.forEach((listener) => listener());
}

export interface CompletionChoice {
  providerId: string;
  modelId: string;
  label: string;
}

/**
 * Every usable enabled model, labeled with its provider so the completion pick is independent.
 * `keep` stays listed even when disabled, so a current pick never vanishes from its picker.
 */
export function completionChoices(
  catalog: AiCatalog,
  keep?: { providerId: string; modelId: string }
): CompletionChoice[] {
  const choices: CompletionChoice[] = [];
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      if (!provider.baseUrl.trim() || !model.model.trim()) continue;
      const kept = keep?.providerId === provider.id && keep.modelId === model.id;
      if (!model.enabled && !kept) continue;
      const modelLabel = model.name.trim() || model.model.trim();
      const providerLabel = provider.name.trim() || provider.baseUrl.trim();
      choices.push({
        providerId: provider.id,
        modelId: model.id,
        label: `${providerLabel} / ${modelLabel}`,
      });
    }
  }
  return choices;
}

/** The completion model, or null when it is missing or no longer in the catalog. */
export function completionEndpoint(
  catalog: AiCatalog,
  settings: CompletionSettings
): ActiveEndpoint | null {
  const provider = catalog.providers.find((item) => item.id === settings.providerId);
  const model = provider?.models.find((item) => item.id === settings.modelId);
  if (!provider?.baseUrl.trim() || !model?.model.trim()) return null;
  return { id: provider.id, baseUrl: provider.baseUrl.trim(), model: model.model.trim() };
}

export function loadCompletionEndpoint(): ActiveEndpoint | null {
  return completionEndpoint(loadAiSettings(), loadCompletionSettings());
}
