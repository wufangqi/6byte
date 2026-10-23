import type { AiMessage } from "../ipc/types";

/** Characters before the caret sent as context. The rest of the file stays local. */
export const COMPLETION_PREFIX = 1_600;
/** Characters after the caret, so the model can see the next words. */
export const COMPLETION_SUFFIX = 240;
const MIN_PREFIX = 4;
const MAX_SUGGESTION = 120;

const SYSTEM =
  "只输出光标后面要补上的文字。不要解释，不要标题，不要思考过程，不要重复上文。写到一句结束或换行就停。";

export function completionSlice(
  doc: string,
  pos: number
): { prefix: string; suffix: string } | null {
  if (pos < 0 || pos > doc.length) return null;
  const prefix = doc.slice(Math.max(0, pos - COMPLETION_PREFIX), pos);
  if (prefix.trim().length < MIN_PREFIX) return null;
  const suffix = doc.slice(pos, Math.min(doc.length, pos + COMPLETION_SUFFIX));
  return { prefix, suffix };
}

export function completionMessages(prefix: string, suffix: string): AiMessage[] {
  const after = suffix.trim() ? `\n\n下文：\n${suffix}` : "";
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: `上文：\n${prefix}${after}\n\n从光标处续写。` },
  ];
}

function stripOverlap(prefix: string, raw: string): string {
  const tail = prefix.slice(-80);
  const max = Math.min(tail.length, raw.length);
  for (let size = max; size >= 4; size -= 1) {
    if (raw.startsWith(tail.slice(tail.length - size))) return raw.slice(size);
  }
  return raw;
}

/** Answer text only, cut to one line and one sentence. Thinking traces never reach here. */
export function visibleSuggestion(prefix: string, raw: string): string {
  let text = stripOverlap(prefix, raw).replace(/^\n+/, "");
  const newline = text.indexOf("\n");
  if (newline >= 0) text = text.slice(0, newline);
  const end = text.search(/[。！？.!?]/);
  if (end >= 0) text = text.slice(0, end + 1);
  return text.slice(0, MAX_SUGGESTION);
}

/** True once the raw reply has a natural stopping point and the request can be cancelled. */
export function suggestionSettled(raw: string): boolean {
  return /[\n。！？.!?]/.test(raw) || raw.length >= MAX_SUGGESTION;
}
