import type { AiMessage } from "../ipc/types";

/** Keep the panel history useful without retaining an unlimited local transcript. */
export const REWRITE_HISTORY_LIMIT = 4;

export interface RewriteTurn {
  instruction: string;
  proposal: string;
}

/**
 * Stores the recent interaction locally for review. The model does not receive
 * the entire transcript again: the newest draft already contains the prior
 * changes, so sending only that draft keeps follow-ups within a bounded prompt.
 */
export function appendRewriteTurn(turns: readonly RewriteTurn[], turn: RewriteTurn): RewriteTurn[] {
  return [...turns, turn].slice(-REWRITE_HISTORY_LIMIT);
}

/**
 * Continue from the accepted-in-panel draft, not from the original selection.
 * The original context remains in `baseMessages`; only the immediately prior
 * proposal is repeated, which avoids sending an unbounded chat transcript.
 */
export function followupRewriteMessages(
  baseMessages: readonly AiMessage[],
  proposal: string,
  instruction: string,
  references = ""
): AiMessage[] {
  const extra = references.trim() ? `\n\n补充引用（仅供参考）：\n${references.trim()}` : "";
  return [
    ...baseMessages,
    { role: "assistant", content: proposal },
    {
      role: "user",
      content: `请继续修改上面这版候选稿。只输出新的完整候选稿，不要解释。\n\n新要求：\n${instruction.trim()}${extra}`,
    },
  ];
}
