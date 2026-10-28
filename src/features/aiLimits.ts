import { useSyncExternalStore } from "react";
import type { AiMessage } from "../ipc/types";

/**
 * How much the AI panel remembers and sends. Three built-in presets cannot be
 * edited; up to five custom sets can. The active set is read at send time, so
 * a change applies from the next request.
 */
export const AI_LIMITS_KEY = "ainative.aiLimits.v1";
export const MAX_CUSTOM_LIMITS = 5;

export interface AiLimits {
  /** Earlier rounds the model sees again. Rewrite follow-ups always keep the latest draft. */
  historyTurns: number;
  /** Characters of earlier rounds; the oldest round is dropped first. */
  historyChars: number;
  /** A larger selection is refused, never cut. */
  selectionChars: number;
  /** Section, nearby lines, file name, outline and `@` references together. */
  contextChars: number;
  rewriteMaxTokens: number;
  askSteps: number;
  /** Characters one question may send, summed over every request including history. */
  askBudget: number;
  askResultChars: number;
  askReadLines: number;
  askMaxTokens: number;
}

export type LimitKey = keyof AiLimits;
export type LimitGroup = "history" | "rewrite" | "ask";
export type LimitUnit = "turns" | "chars" | "tokens" | "steps" | "lines";

export interface LimitField {
  key: LimitKey;
  group: LimitGroup;
  unit: LimitUnit;
  min: number;
  max: number;
}

export const LIMIT_FIELDS: LimitField[] = [
  { key: "historyTurns", group: "history", unit: "turns", min: 0, max: 20 },
  { key: "historyChars", group: "history", unit: "chars", min: 0, max: 100_000 },
  { key: "selectionChars", group: "rewrite", unit: "chars", min: 500, max: 100_000 },
  { key: "contextChars", group: "rewrite", unit: "chars", min: 0, max: 64_000 },
  { key: "rewriteMaxTokens", group: "rewrite", unit: "tokens", min: 256, max: 32_768 },
  { key: "askSteps", group: "ask", unit: "steps", min: 1, max: 12 },
  { key: "askBudget", group: "ask", unit: "chars", min: 2_000, max: 200_000 },
  { key: "askResultChars", group: "ask", unit: "chars", min: 500, max: 10_000 },
  { key: "askReadLines", group: "ask", unit: "lines", min: 10, max: 400 },
  { key: "askMaxTokens", group: "ask", unit: "tokens", min: 256, max: 8_192 },
];

export type PresetId = "simple" | "balanced" | "max";

export const PRESET_LIMITS: Record<PresetId, AiLimits> = {
  simple: {
    historyTurns: 2,
    historyChars: 3_000,
    selectionChars: 4_000,
    contextChars: 3_000,
    rewriteMaxTokens: 2_048,
    askSteps: 2,
    askBudget: 6_000,
    askResultChars: 1_200,
    askReadLines: 30,
    askMaxTokens: 768,
  },
  balanced: {
    historyTurns: 4,
    historyChars: 8_000,
    selectionChars: 12_000,
    contextChars: 8_000,
    rewriteMaxTokens: 4_096,
    askSteps: 4,
    askBudget: 12_000,
    askResultChars: 2_000,
    askReadLines: 40,
    askMaxTokens: 1_024,
  },
  max: {
    historyTurns: 10,
    historyChars: 30_000,
    selectionChars: 40_000,
    contextChars: 24_000,
    rewriteMaxTokens: 8_192,
    askSteps: 8,
    askBudget: 60_000,
    askResultChars: 4_000,
    askReadLines: 120,
    askMaxTokens: 2_048,
  },
};

export const PRESET_IDS: PresetId[] = ["simple", "balanced", "max"];
export const DEFAULT_LIMITS_ID: PresetId = "balanced";

export interface CustomLimits {
  id: string;
  name: string;
  limits: AiLimits;
}

export interface LimitsStore {
  /** A preset id or a custom id. */
  activeId: string;
  custom: CustomLimits[];
}

export const DEFAULT_LIMITS_STORE: LimitsStore = { activeId: DEFAULT_LIMITS_ID, custom: [] };

export function isPresetId(id: string): id is PresetId {
  return (PRESET_IDS as string[]).includes(id);
}

export function clampLimit(key: LimitKey, value: number): number {
  const field = LIMIT_FIELDS.find((item) => item.key === key)!;
  const number = Number.isFinite(value) ? Math.round(value) : PRESET_LIMITS.balanced[key];
  return Math.max(field.min, Math.min(field.max, number));
}

export function cleanLimits(value: unknown): AiLimits {
  const record = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const limits = { ...PRESET_LIMITS.balanced };
  for (const { key } of LIMIT_FIELDS) {
    const raw = record[key];
    if (typeof raw === "number") limits[key] = clampLimit(key, raw);
  }
  return limits;
}

export function parseLimitsStore(raw: string | null | undefined): LimitsStore {
  if (!raw) return DEFAULT_LIMITS_STORE;
  try {
    const value = JSON.parse(raw) as { activeId?: unknown; custom?: unknown };
    const custom: CustomLimits[] = [];
    if (Array.isArray(value.custom)) {
      for (const item of value.custom) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id.trim() : "";
        if (!id || isPresetId(id) || custom.some((existing) => existing.id === id)) continue;
        const name = typeof record.name === "string" ? record.name.trim().slice(0, 40) : "";
        custom.push({ id, name, limits: cleanLimits(record.limits) });
        if (custom.length === MAX_CUSTOM_LIMITS) break;
      }
    }
    const requested = typeof value.activeId === "string" ? value.activeId : "";
    const activeId =
      isPresetId(requested) || custom.some((item) => item.id === requested)
        ? requested
        : DEFAULT_LIMITS_ID;
    return { activeId, custom };
  } catch {
    return DEFAULT_LIMITS_STORE;
  }
}

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedStore: LimitsStore = DEFAULT_LIMITS_STORE;

export function loadLimitsStore(): LimitsStore {
  let raw: string | null;
  try {
    raw = localStorage.getItem(AI_LIMITS_KEY);
  } catch {
    raw = null;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedStore = parseLimitsStore(raw);
  }
  return cachedStore;
}

export function saveLimitsStore(store: LimitsStore): void {
  try {
    localStorage.setItem(AI_LIMITS_KEY, JSON.stringify(store));
  } catch {
    // Settings are a convenience; a locked store keeps the previous values.
  }
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLimitsStore(): LimitsStore {
  return useSyncExternalStore(subscribe, loadLimitsStore, loadLimitsStore);
}

export function limitsOf(store: LimitsStore, id = store.activeId): AiLimits {
  if (isPresetId(id)) return PRESET_LIMITS[id];
  return store.custom.find((item) => item.id === id)?.limits ?? PRESET_LIMITS[DEFAULT_LIMITS_ID];
}

export function activeLimits(): AiLimits {
  return limitsOf(loadLimitsStore());
}

export function useActiveLimits(): AiLimits {
  return limitsOf(useLimitsStore());
}

function newLimitsId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `l${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Copy a set into a new custom one and make it active. `null` when five already exist. */
export function addCustomLimits(
  store: LimitsStore,
  name: string,
  from: AiLimits
): LimitsStore | null {
  if (store.custom.length >= MAX_CUSTOM_LIMITS) return null;
  const item: CustomLimits = {
    id: newLimitsId(),
    name: name.trim().slice(0, 40),
    limits: { ...from },
  };
  return { activeId: item.id, custom: [...store.custom, item] };
}

export function updateCustomLimits(
  store: LimitsStore,
  id: string,
  patch: { name?: string; limits?: Partial<AiLimits> }
): LimitsStore {
  return {
    ...store,
    custom: store.custom.map((item) => {
      if (item.id !== id) return item;
      const limits = { ...item.limits };
      for (const [key, value] of Object.entries(patch.limits ?? {}) as [LimitKey, number][]) {
        limits[key] = clampLimit(key, value);
      }
      return {
        ...item,
        name: patch.name === undefined ? item.name : patch.name.slice(0, 40),
        limits,
      };
    }),
  };
}

export function removeCustomLimits(store: LimitsStore, id: string): LimitsStore {
  return {
    activeId: store.activeId === id ? DEFAULT_LIMITS_ID : store.activeId,
    custom: store.custom.filter((item) => item.id !== id),
  };
}

export function applyLimits(store: LimitsStore, id: string): LimitsStore {
  if (!isPresetId(id) && !store.custom.some((item) => item.id === id)) return store;
  return { ...store, activeId: id };
}

/**
 * Rough token count for fitting a request into a model's context window:
 * one per CJK character, one per four other characters, plus framing per message.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1;
    }
  }
  return cjk + Math.ceil((text.length - cjk) / 4);
}

export function messageTokens(messages: readonly AiMessage[]): number {
  return messages.reduce(
    (sum, message) =>
      sum +
      4 +
      estimateTokens(message.content) +
      (message.toolCalls?.reduce(
        (size, call) => size + estimateTokens(call.function.arguments) + 8,
        0
      ) ?? 0),
    0
  );
}

/** Smallest reply worth asking for when the prompt nearly fills the window. */
export const MIN_REPLY_TOKENS = 256;

export class ContextOverflowError extends Error {
  constructor(
    readonly promptTokens: number,
    readonly contextTokens: number
  ) {
    super(`context overflow: ${promptTokens} / ${contextTokens}`);
    this.name = "ContextOverflowError";
  }
}

/**
 * Output tokens for a prompt of `promptTokens` in a window of `contextTokens`.
 * No window means no extra limit. Throws when not even a short reply fits.
 */
export function replyTokens(
  promptTokens: number,
  maxTokens: number,
  contextTokens?: number
): number {
  if (!contextTokens) return maxTokens;
  const room = contextTokens - promptTokens;
  if (room < MIN_REPLY_TOKENS) throw new ContextOverflowError(promptTokens, contextTokens);
  return Math.min(maxTokens, room);
}
