import type { AiUsage } from "../ipc/types";

/**
 * AI panel conversations, kept on this device only.
 *
 * Entries hold the instructions, rewrites and answers the user already saw.
 * Thinking traces, prompts and tool results are not stored. Text fields are
 * clipped so one long selection cannot fill the store.
 */
export const AI_HISTORY_KEY = "ainative.aiHistory.v1";
export const HISTORY_MAX_CONVERSATIONS = 30;
export const HISTORY_MAX_ENTRIES = 60;
export const HISTORY_MAX_TEXT = 6_000;

export type ChatMode = "rewrite" | "ask";

export interface ChatChip {
  kind: "selection" | "file";
  label: string;
}

export interface UserEntry {
  id: string;
  role: "user";
  mode: ChatMode;
  text: string;
  chips: ChatChip[];
}

export type RewriteStatus =
  | "live"
  | "pending"
  | "superseded"
  | "accepted"
  | "discarded"
  | "stale"
  | "cancelled"
  | "failed"
  | "closed";

export interface RewriteEntry {
  id: string;
  role: "rewrite";
  model: string;
  original: string;
  text: string;
  status: RewriteStatus;
  elapsedMs?: number;
  usage?: AiUsage;
  error?: string;
}

export interface AskStep {
  name: string;
  detail: string;
}

export type AskStatus = "live" | "done" | "failed" | "cancelled";

export interface AskEntry {
  id: string;
  role: "ask";
  model: string;
  answer: string;
  trace: AskStep[];
  sent: number;
  status: AskStatus;
  elapsedMs?: number;
}

export type ChatEntry = UserEntry | RewriteEntry | AskEntry;

export interface Conversation {
  id: string;
  title: string;
  updatedAt: number;
  entries: ChatEntry[];
}

const REWRITE_STATUSES: RewriteStatus[] = [
  "live",
  "pending",
  "superseded",
  "accepted",
  "discarded",
  "stale",
  "cancelled",
  "failed",
  "closed",
];
const ASK_STATUSES: AskStatus[] = ["live", "done", "failed", "cancelled"];

/** Seconds with one decimal, the unit every elapsed time in the panel uses. */
export function seconds(ms: number | undefined): string {
  return ((ms ?? 0) / 1000).toFixed(1);
}

export function newChatId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `c${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function clip(text: string): string {
  return text.length > HISTORY_MAX_TEXT ? `${text.slice(0, HISTORY_MAX_TEXT)}…` : text;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageOf(value: unknown): AiUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const promptTokens = num(record.promptTokens);
  const completionTokens = num(record.completionTokens);
  if (promptTokens === undefined || completionTokens === undefined) return undefined;
  return { promptTokens, completionTokens };
}

/** A stored entry can no longer be acted on: its editor preview and stream are gone. */
function settle(entry: ChatEntry): ChatEntry {
  if (entry.role === "rewrite" && (entry.status === "live" || entry.status === "pending")) {
    return { ...entry, status: "closed" };
  }
  if (entry.role === "ask" && entry.status === "live") return { ...entry, status: "cancelled" };
  return entry;
}

function parseEntry(value: unknown): ChatEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = str(record.id);
  if (!id) return null;
  if (record.role === "user") {
    const chips = Array.isArray(record.chips)
      ? record.chips.flatMap((chip): ChatChip[] => {
          if (!chip || typeof chip !== "object") return [];
          const item = chip as Record<string, unknown>;
          const kind =
            item.kind === "file" ? "file" : item.kind === "selection" ? "selection" : null;
          const label = str(item.label);
          return kind && label ? [{ kind, label }] : [];
        })
      : [];
    return {
      id,
      role: "user",
      mode: record.mode === "ask" ? "ask" : "rewrite",
      text: clip(str(record.text)),
      chips,
    };
  }
  if (record.role === "rewrite") {
    const status = REWRITE_STATUSES.find((item) => item === record.status) ?? "closed";
    return settle({
      id,
      role: "rewrite",
      model: str(record.model),
      original: clip(str(record.original)),
      text: clip(str(record.text)),
      status,
      elapsedMs: num(record.elapsedMs),
      usage: usageOf(record.usage),
      error: str(record.error) || undefined,
    });
  }
  if (record.role === "ask") {
    const status = ASK_STATUSES.find((item) => item === record.status) ?? "done";
    const trace = Array.isArray(record.trace)
      ? record.trace.flatMap((step): AskStep[] => {
          if (!step || typeof step !== "object") return [];
          const item = step as Record<string, unknown>;
          const name = str(item.name);
          return name ? [{ name, detail: str(item.detail) }] : [];
        })
      : [];
    return settle({
      id,
      role: "ask",
      model: str(record.model),
      answer: clip(str(record.answer)),
      trace,
      sent: num(record.sent) ?? 0,
      status,
      elapsedMs: num(record.elapsedMs),
    });
  }
  return null;
}

export function parseHistory(raw: string | null): Conversation[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .flatMap((item): Conversation[] => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        const id = str(record.id);
        const entries = Array.isArray(record.entries)
          ? record.entries.flatMap((entry) => {
              const parsed = parseEntry(entry);
              return parsed ? [parsed] : [];
            })
          : [];
        if (!id || entries.length === 0) return [];
        return [
          {
            id,
            title: str(record.title) || conversationTitle(entries),
            updatedAt: num(record.updatedAt) ?? 0,
            entries: entries.slice(-HISTORY_MAX_ENTRIES),
          },
        ];
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, HISTORY_MAX_CONVERSATIONS);
  } catch {
    return [];
  }
}

/** The first instruction, on one line. Empty when the conversation has none yet. */
export function conversationTitle(entries: ChatEntry[]): string {
  const first = entries.find((entry): entry is UserEntry => entry.role === "user");
  const text = first?.text.replace(/\s+/g, " ").trim() ?? "";
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

export function loadHistory(): Conversation[] {
  try {
    return parseHistory(localStorage.getItem(AI_HISTORY_KEY));
  } catch {
    return [];
  }
}

function write(list: Conversation[]): void {
  try {
    localStorage.setItem(AI_HISTORY_KEY, JSON.stringify(list));
  } catch {
    // History is a convenience; a full or locked store must never break the panel.
  }
}

/** Insert or replace one conversation, newest first. Returns the stored list. */
export function saveConversation(
  conversation: Omit<Conversation, "title" | "updatedAt"> & { updatedAt?: number }
): Conversation[] {
  const entries = conversation.entries.slice(-HISTORY_MAX_ENTRIES).map((entry): ChatEntry => {
    if (entry.role === "user") return { ...entry, text: clip(entry.text) };
    if (entry.role === "rewrite") {
      return { ...entry, original: clip(entry.original), text: clip(entry.text) };
    }
    return { ...entry, answer: clip(entry.answer) };
  });
  if (entries.length === 0) return loadHistory();
  const stored: Conversation = {
    id: conversation.id,
    title: conversationTitle(entries),
    updatedAt: conversation.updatedAt ?? Date.now(),
    entries,
  };
  const list = [stored, ...loadHistory().filter((item) => item.id !== conversation.id)].slice(
    0,
    HISTORY_MAX_CONVERSATIONS
  );
  write(list);
  return list;
}

export function removeConversation(id: string): Conversation[] {
  const list = loadHistory().filter((item) => item.id !== id);
  write(list);
  return list;
}

export function clearHistory(): void {
  write([]);
}

/** Restore a stored conversation. Anything that was still open becomes read-only. */
export function restoreEntries(conversation: Conversation): ChatEntry[] {
  return conversation.entries.map(settle);
}
