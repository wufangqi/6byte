import type { AiMessage } from "../ipc/types";

const SYSTEM =
  "只根据下面给出的当前文档回答。不要读取或猜测其他文件，不要声称看过整个工作区。文档被截断时要说明你只看到了开头。";

/**
 * One question about the file on screen. The model receives no workspace tools,
 * and the document is cut to `maxChars` so a long file cannot fill the request.
 */
export function documentQuestion(
  filename: string,
  content: string,
  question: string,
  maxChars: number
): [AiMessage, AiMessage] {
  const room = Math.max(0, maxChars - question.length - SYSTEM.length - filename.length - 32);
  const clipped = content.length > room;
  const body = clipped ? content.slice(0, room) : content;
  const note = clipped ? "\n\n（文档较长，这里只包含开头。）" : "";
  return [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `文件：${filename}\n\n${body}${note}\n\n问题：\n${question.trim()}`,
    },
  ];
}
