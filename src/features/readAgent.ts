import type { AiMessage, AiToolCall, AiToolDefinition } from "../ipc/types";
import { BLOCKED_MESSAGE, blockedReason } from "./agentAccess";
import { ContextOverflowError, MIN_REPLY_TOKENS, messageTokens, replyTokens } from "./aiLimits";
import { pathInsideRoot } from "./fileTree";

/** The only tools a read-only agent may call. */
export const AGENT_TOOLS = ["list_dir", "grep", "read_range", "outline"] as const;
export type AgentToolName = (typeof AGENT_TOOLS)[number];
export const AGENT_MAX_STEPS = 4;
export const AGENT_RESULT_CHARS = 2_000;
export const READ_RANGE_MAX = 40;
/** Total characters one question may send to the model, summed over every request. */
export const AGENT_SEND_BUDGET = 12_000;
export const AGENT_MAX_TOKENS = 1_024;

/** Native schemas for providers that support OpenAI-style function calling. */
export const AGENT_TOOL_DEFINITIONS: AiToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List visible files and directories at a workspace path.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative path." } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search workspace files with a regular expression.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression to search for." },
          path: { type: "string", description: "Workspace-relative path." },
        },
        required: ["pattern", "path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_range",
      description: "Read a bounded 1-based line range from one workspace file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          start: { type: "integer", minimum: 1, description: "First 1-based line." },
          count: { type: "integer", minimum: 1, maximum: READ_RANGE_MAX },
        },
        required: ["path", "start", "count"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "outline",
      description: "Read headings from one workspace file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative file path." } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
];

export type AgentStop = "answered" | "steps" | "budget" | "cancelled";

export interface AgentProgress {
  trace: AgentTrace[];
  /** Characters sent to the model so far, summed over every request. */
  sent: number;
}

export interface AgentResult extends AgentProgress {
  answer: string;
  stop: AgentStop;
}

export interface AgentCall {
  name: AgentToolName;
  path: string;
  pattern: string;
  start: number;
  count: number;
}

export interface AgentTrace {
  name: string;
  detail: string;
  result: string;
}

export interface AgentTools {
  listDir(path: string): Promise<string>;
  grep(pattern: string, path: string): Promise<string>;
  readRange(path: string, start: number, count: number): Promise<string>;
  outline(path: string): Promise<string>;
}

export interface AgentCompletion {
  text: string;
  toolCalls?: AiToolCall[];
}

type AgentTurn =
  | { kind: "answer"; answer: string }
  | { kind: "call"; call: AgentCall }
  | { kind: "rejected"; tool: string }
  | { kind: "invalid"; message: string }
  | { kind: "empty" };

const agentPreamble = (
  readLines: number
) => `你是只读助手。只能查看工作区，不能创建、修改或删除文件。
每次只输出一个 JSON 对象，不要加别的文字。
查找目录：{"tool":"list_dir","path":"."}
搜索：{"tool":"grep","pattern":"正则","path":"."}
读行：{"tool":"read_range","path":"文件","start":1,"count":${Math.min(40, readLines)}}
读大纲：{"tool":"outline","path":"文件"}
回答：{"answer":"给用户的回答"}
count 最大 ${readLines}。路径必须留在工作区内。隐藏文件、密钥文件和用户禁读的路径读不到。
如果服务支持 function calling，每轮至多调用一个已提供的只读函数；否则按上面的 JSON 文本格式输出。
前面的问答只是对话上下文；回答当前问题时，需要的内容仍要用工具重新查。`;

export function agentSystem(root: string, readLines = READ_RANGE_MAX): string {
  return `${agentPreamble(readLines)}\n工作区：${root}`;
}

/** Join a user path onto the workspace root. `..` and outside paths are refused. */
export function resolveWorkspacePath(root: string, input: string): string | null {
  const base = root.trim().replace(/[\\/]+$/, "");
  if (!base) return null;
  const windows = base.includes("\\") || /^[A-Za-z]:/.test(base);
  const sep = windows ? "\\" : "/";
  const rootPath = base.replace(windows ? /\//g : /\\/g, sep);
  const raw = input.trim();
  if (!raw || raw === "." || raw === "./" || raw === ".\\") return rootPath;
  const unified = raw.replace(/\\/g, sep).replace(/\//g, sep);
  const absolute =
    (windows && /^[A-Za-z]:/.test(unified)) ||
    unified.startsWith("\\\\") ||
    unified.startsWith("/");
  if (absolute) {
    const cleaned = unified.replace(/[\\/]+$/, "");
    return pathInsideRoot(rootPath, cleaned) ? cleaned : null;
  }
  const parts: string[] = [];
  for (const part of unified.split(sep)) {
    if (!part || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  if (parts.length === 0) return rootPath;
  const joined = `${rootPath}${sep}${parts.join(sep)}`;
  return pathInsideRoot(rootPath, joined) ? joined : null;
}

export function parseAgentTurn(text: string, readLines = READ_RANGE_MAX): AgentTurn {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "empty" };
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return { kind: "answer", answer: trimmed };
  let value: unknown;
  try {
    value = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return { kind: "answer", answer: trimmed };
  }
  if (!value || typeof value !== "object") return { kind: "answer", answer: trimmed };
  const record = value as Record<string, unknown>;
  const tool = typeof record.tool === "string" ? record.tool : "";
  if (tool) return toolTurn(tool, record, readLines);
  if (typeof record.answer === "string" && record.answer.trim()) {
    return { kind: "answer", answer: record.answer.trim() };
  }
  return { kind: "answer", answer: trimmed };
}

function toolTurn(tool: string, record: Record<string, unknown>, readLines: number): AgentTurn {
  if (!AGENT_TOOLS.includes(tool as AgentToolName)) return { kind: "rejected", tool };
  return {
    kind: "call",
    call: {
      name: tool as AgentToolName,
      path: typeof record.path === "string" ? record.path : ".",
      pattern: typeof record.pattern === "string" ? record.pattern : "",
      start: positiveInt(record.start, 1),
      count: Math.min(readLines, positiveInt(record.count, readLines)),
    },
  };
}

export function parseNativeAgentCall(call: AiToolCall, readLines = READ_RANGE_MAX): AgentTurn {
  if (call.type !== "function" || !call.function?.name) {
    return { kind: "invalid", message: "模型返回了无效的工具调用。" };
  }
  try {
    const value: unknown = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { kind: "invalid", message: "模型返回的工具参数不是对象。" };
    }
    return toolTurn(call.function.name, value as Record<string, unknown>, readLines);
  } catch {
    return { kind: "invalid", message: "模型返回的工具参数不是有效 JSON。" };
  }
}

function positiveInt(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.floor(number);
}

export function clipAgentResult(text: string, max = AGENT_RESULT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…已截断`;
}

function requestSize(messages: AiMessage[]): number {
  return messages.reduce(
    (total, message) =>
      total +
      message.content.length +
      (message.toolCallId?.length ?? 0) +
      (message.toolCalls?.reduce(
        (size, call) =>
          size + call.id.length + call.function.name.length + call.function.arguments.length,
        0
      ) ?? 0),
    0
  );
}

function normalizeCompletion(reply: string | AgentCompletion): AgentCompletion {
  return typeof reply === "string" ? { text: reply } : reply;
}

function appendToolResult(
  messages: AiMessage[],
  text: string,
  nativeCalls: AiToolCall[],
  result: string
): void {
  if (nativeCalls.length === 0) {
    messages.push({ role: "assistant", content: text });
    messages.push({
      role: "user",
      content: `工具结果：\n${result}\n若已经够用，输出 {"answer":"..."}。`,
    });
    return;
  }
  messages.push({ role: "assistant", content: text, toolCalls: nativeCalls });
  messages.push({ role: "tool", toolCallId: nativeCalls[0].id, content: result });
  for (const call of nativeCalls.slice(1)) {
    messages.push({
      role: "tool",
      toolCallId: call.id,
      content: "拒绝：每轮只能调用一个工具。",
    });
  }
}

/**
 * Earlier questions and answers of this conversation, oldest first, as
 * alternating user/assistant messages. Keeps the newest `turns` pairs that fit
 * in `chars`.
 */
export function askHistory(
  pairs: readonly { question: string; answer: string }[],
  turns: number,
  chars: number
): AiMessage[] {
  const kept: { question: string; answer: string }[] = [];
  let size = 0;
  for (const pair of [...pairs].reverse()) {
    if (kept.length >= turns) break;
    const next = pair.question.length + pair.answer.length;
    if (size + next > chars) break;
    size += next;
    kept.unshift(pair);
  }
  return kept.flatMap((pair) => [
    { role: "user" as const, content: pair.question },
    { role: "assistant" as const, content: pair.answer },
  ]);
}

export async function runReadAgent(input: {
  question: string;
  root: string;
  /** `maxTokens` is the reply size that still fits the model window. */
  complete(
    messages: AiMessage[],
    signal?: AbortSignal,
    maxTokens?: number
  ): Promise<string | AgentCompletion>;
  tools: AgentTools;
  maxSteps?: number;
  /** Characters allowed over all requests. Defaults to `AGENT_SEND_BUDGET`. */
  budget?: number;
  readLines?: number;
  resultChars?: number;
  /** Earlier rounds from `askHistory`; dropped oldest-first when the window is tight. */
  history?: readonly AiMessage[];
  maxTokens?: number;
  /** Model context window in tokens. Unset means no extra limit. */
  contextTokens?: number;
  /** Extra paths the agent may not open, on top of hidden and key files. */
  denylist?: readonly string[];
  signal?: AbortSignal;
  onProgress?(progress: AgentProgress): void;
}): Promise<AgentResult> {
  const maxSteps = input.maxSteps ?? AGENT_MAX_STEPS;
  const budget = input.budget ?? AGENT_SEND_BUDGET;
  const readLines = input.readLines ?? READ_RANGE_MAX;
  const resultChars = input.resultChars ?? AGENT_RESULT_CHARS;
  const maxTokens = input.maxTokens ?? AGENT_MAX_TOKENS;
  const messages: AiMessage[] = [
    { role: "system", content: agentSystem(input.root, readLines) },
    ...(input.history ?? []),
    { role: "user", content: input.question.trim() },
  ];
  let historyLeft = input.history?.length ?? 0;
  const trace: AgentTrace[] = [];
  let sent = 0;
  const finish = (answer: string, stop: AgentStop): AgentResult => ({
    answer,
    trace,
    sent,
    stop,
  });
  const report = () => input.onProgress?.({ trace: [...trace], sent });
  const cancelled = () => finish("已取消。文件没有被修改。", "cancelled");

  for (let step = 0; step < maxSteps; step += 1) {
    if (input.signal?.aborted) return cancelled();
    const window = input.contextTokens;
    while (
      historyLeft >= 2 &&
      ((window && messageTokens(messages) + MIN_REPLY_TOKENS > window) ||
        sent + requestSize(messages) > budget)
    ) {
      messages.splice(1, 2);
      historyLeft -= 2;
    }
    let reply: number;
    try {
      reply = replyTokens(messageTokens(messages), maxTokens, window);
    } catch (error) {
      if (!(error instanceof ContextOverflowError)) throw error;
      return finish(
        `内容超出模型的上下文长度（约 ${error.promptTokens} / ${error.contextTokens} token），没有得出回答。可以在设置里调低查找结果上限，或给模型设更大的上下文长度。文件没有被修改。`,
        "budget"
      );
    }
    const size = requestSize(messages);
    if (sent + size > budget) {
      return finish(
        `已达到发送上限（约 ${budget} 个字符），没有得出回答。文件没有被修改。`,
        "budget"
      );
    }
    sent += size;
    report();
    let completion: AgentCompletion;
    try {
      completion = normalizeCompletion(await input.complete(messages, input.signal, reply));
    } catch (error) {
      if (input.signal?.aborted) return cancelled();
      throw error;
    }
    if (input.signal?.aborted) return cancelled();
    const text = completion.text;
    const nativeCalls = completion.toolCalls ?? [];
    const turn =
      nativeCalls.length > 0
        ? parseNativeAgentCall(nativeCalls[0], readLines)
        : parseAgentTurn(completion.text, readLines);
    if (turn.kind === "answer") return finish(turn.answer, "answered");
    if (turn.kind === "empty") {
      messages.push({ role: "user", content: "请输出一个 JSON 对象。" });
      continue;
    }
    if (turn.kind === "rejected") {
      const result = `拒绝：没有「${turn.tool}」。只能列目录、搜索、按区间读、读大纲，不能改文件。`;
      trace.push({ name: turn.tool || "rejected", detail: "", result });
      report();
      appendToolResult(messages, text, nativeCalls, result);
      continue;
    }
    if (turn.kind === "invalid") {
      trace.push({ name: "invalid", detail: "", result: turn.message });
      report();
      appendToolResult(messages, text, nativeCalls, turn.message);
      continue;
    }
    const result = clipAgentResult(
      await dispatchTool(input.root, turn.call, input.tools, input.denylist ?? []),
      resultChars
    );
    trace.push({
      name: turn.call.name,
      detail: turn.call.name === "grep" ? turn.call.pattern : turn.call.path,
      result,
    });
    report();
    appendToolResult(messages, text, nativeCalls, result);
  }
  return finish("查找次数已用完，没有得出回答。文件没有被修改。", "steps");
}

async function dispatchTool(
  root: string,
  call: AgentCall,
  tools: AgentTools,
  denylist: readonly string[]
): Promise<string> {
  const path = resolveWorkspacePath(root, call.path);
  if (!path) return "拒绝：路径不在工作区。";
  if (blockedReason(root, path, denylist)) return BLOCKED_MESSAGE;
  if (call.name === "list_dir") return tools.listDir(path);
  if (call.name === "grep") {
    const pattern = call.pattern.trim().slice(0, 80);
    if (!pattern) return "搜索内容不能为空。";
    return tools.grep(pattern, path);
  }
  if (call.name === "read_range") return tools.readRange(path, call.start, call.count);
  return tools.outline(path);
}
