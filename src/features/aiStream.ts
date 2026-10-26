import type { AiMessage } from "../ipc/types";

/** Selection is never truncated. Above this, the request is refused. */
export const SELECTION_CHAR_LIMIT = 12_000;

/** Upper bound sent with a rewrite so a stream cannot run without a limit. */
export const REWRITE_MAX_TOKENS = 4096;

const STREAM_SYSTEM = "按用户要求处理用户选中的文字，只输出处理后的正文，不要解释。";

export function modelHost(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  try {
    return new URL(trimmed).host || trimmed;
  } catch {
    return trimmed;
  }
}

/** Origin a stored key is bound to. Default ports are omitted, matching Rust. */
export function endpointOrigin(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function selectionTooLarge(selection: string): boolean {
  return selection.length > SELECTION_CHAR_LIMIT;
}

/** Selection and instruction only. The panel adds the document through `assembleRewrite`. */
export function streamMessages(selection: string, instruction: string): AiMessage[] {
  return [
    { role: "system", content: STREAM_SYSTEM },
    { role: "user", content: `选区：\n${selection}\n\n要求：\n${instruction.trim()}` },
  ];
}

/**
 * One-click actions (T39). Each entry keeps the i18n keys so the panel can
 * render the label and send the matching prompt without a second lookup table.
 */
export const QUICK_ACTIONS = [
  { id: "polish", labelKey: "ai.stream.action.polish", promptKey: "ai.stream.prompt.polish" },
  {
    id: "translate",
    labelKey: "ai.stream.action.translate",
    promptKey: "ai.stream.prompt.translate",
  },
  {
    id: "summarize",
    labelKey: "ai.stream.action.summarize",
    promptKey: "ai.stream.prompt.summarize",
  },
] as const;

export type QuickActionId = (typeof QUICK_ACTIONS)[number]["id"];

/** Quick actions reuse the normal rewrite path; only the instruction differs. */
export function quickActionMessages(selection: string, prompt: string): AiMessage[] {
  return streamMessages(selection, prompt);
}

export function outgoingChars(messages: readonly { content: string }[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}

export type StreamPhase = "idle" | "waiting" | "streaming" | "done" | "cancelled" | "error";

export interface StreamView {
  phase: StreamPhase;
  /** Rewrite that can be written into the document. */
  text: string;
  /** Thinking trace. Never written into the document. */
  thinking: string;
  error: string | null;
}

export const IDLE_STREAM: StreamView = { phase: "idle", text: "", thinking: "", error: null };

export type StreamAction =
  | { type: "start" }
  | { type: "delta"; delta: string; kind?: "content" | "reasoning" }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "cancel" };

/** Tokens accumulate here. Cancelling drops both the rewrite and the thinking trace. */
export function reduceStream(state: StreamView, action: StreamAction): StreamView {
  if (action.type === "start") {
    return { phase: "waiting", text: "", thinking: "", error: null };
  }
  if (state.phase === "cancelled" || state.phase === "done" || state.phase === "idle") {
    return state;
  }
  switch (action.type) {
    case "delta":
      if (state.phase !== "waiting" && state.phase !== "streaming") return state;
      if (action.kind === "reasoning") {
        return {
          phase: "streaming",
          text: state.text,
          thinking: state.thinking + action.delta,
          error: null,
        };
      }
      return {
        phase: "streaming",
        text: state.text + action.delta,
        thinking: state.thinking,
        error: null,
      };
    case "done":
      if (state.phase !== "waiting" && state.phase !== "streaming") return state;
      return { ...state, phase: "done", error: null };
    case "error":
      return { ...state, phase: "error", error: action.message };
    case "cancel":
      if (state.phase !== "waiting" && state.phase !== "streaming") return state;
      return { phase: "cancelled", text: "", thinking: "", error: null };
    default:
      return state;
  }
}
