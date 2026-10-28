import type { AiMessage } from "../ipc/types";
import { MIN_REPLY_TOKENS, messageTokens } from "./aiLimits";

/** Rounds kept per rewrite session: the largest history setting plus the latest draft. */
export const REWRITE_TURNS_KEPT = 21;

export interface RewriteTurn {
  instruction: string;
  proposal: string;
}

export function appendRewriteTurn(
  turns: readonly RewriteTurn[],
  turn: RewriteTurn,
  limit = REWRITE_TURNS_KEPT
): RewriteTurn[] {
  return [...turns, turn].slice(-limit);
}

function followupText(instruction: string, references = ""): string {
  const extra = references.trim() ? `\n\n补充引用（仅供参考）：\n${references.trim()}` : "";
  return `请继续修改上面这版候选稿。只输出新的完整候选稿，不要解释。\n\n新要求：\n${instruction.trim()}${extra}`;
}

function build(
  base: readonly AiMessage[],
  kept: readonly RewriteTurn[],
  instruction: string,
  references: string
): AiMessage[] {
  const messages: AiMessage[] = [...base];
  kept.forEach((turn, index) => {
    // The first kept round answers the request in `base`, or one that was dropped.
    if (index > 0) messages.push({ role: "user", content: followupText(turn.instruction) });
    messages.push({ role: "assistant", content: turn.proposal });
  });
  messages.push({ role: "user", content: followupText(instruction, references) });
  return messages;
}

/**
 * A follow-up that replays earlier rounds of this rewrite.
 *
 * `base` holds the selection, its context and the first request. The latest
 * draft is always sent; up to `historyTurns` rounds in total are replayed, then
 * the oldest are dropped while they exceed `historyChars` or the model window.
 * Dropped rounds' references are never resent.
 */
export function rewriteFollowupMessages(input: {
  base: readonly AiMessage[];
  turns: readonly RewriteTurn[];
  instruction: string;
  references?: string;
  historyTurns: number;
  historyChars: number;
  contextTokens?: number;
}): AiMessage[] {
  const references = input.references ?? "";
  let kept = input.turns.slice(-Math.max(1, input.historyTurns));
  const historySize = (rounds: readonly RewriteTurn[]) =>
    rounds.reduce(
      (sum, turn, index) => sum + turn.proposal.length + (index > 0 ? turn.instruction.length : 0),
      0
    );
  while (kept.length > 1 && historySize(kept) > input.historyChars) kept = kept.slice(1);
  let messages = build(input.base, kept, input.instruction, references);
  while (
    kept.length > 1 &&
    input.contextTokens &&
    messageTokens(messages) + MIN_REPLY_TOKENS > input.contextTokens
  ) {
    kept = kept.slice(1);
    messages = build(input.base, kept, input.instruction, references);
  }
  return messages;
}
