import type { AiMessage } from "../ipc/types";
import { pathInsideRoot } from "./fileTree";

/** The only tools a read-only agent may call. */
export const AGENT_TOOLS = ["list_dir", "grep", "read_range", "outline"] as const;
export type AgentToolName = (typeof AGENT_TOOLS)[number];

export const AGENT_MAX_STEPS = 4;
export const AGENT_RESULT_CHARS = 2_000;
export const READ_RANGE_MAX = 40;

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

type AgentTurn =
  | { kind: "answer"; answer: string }
  | { kind: "call"; call: AgentCall }
  | { kind: "rejected"; tool: string }
  | { kind: "empty" };

const AGENT_PREAMBLE = `你是只读助手。只能查看工作区，不能创建、修改或删除文件。
每次只输出一个 JSON 对象，不要加别的文字。
查找目录：{"tool":"list_dir","path":"."}
搜索：{"tool":"grep","pattern":"正则","path":"."}
读行：{"tool":"read_range","path":"文件","start":1,"count":40}
读大纲：{"tool":"outline","path":"文件"}
回答：{"answer":"给用户的回答"}
count 最大 ${READ_RANGE_MAX}。路径必须留在工作区内。`;

export function agentSystem(root: string): string {
  return `${AGENT_PREAMBLE}\n工作区：${root}`;
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

export function parseAgentTurn(text: string): AgentTurn {
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
  if (tool) {
    if (!AGENT_TOOLS.includes(tool as AgentToolName)) return { kind: "rejected", tool };
    return {
      kind: "call",
      call: {
        name: tool as AgentToolName,
        path: typeof record.path === "string" ? record.path : ".",
        pattern: typeof record.pattern === "string" ? record.pattern : "",
        start: positiveInt(record.start, 1),
        count: Math.min(READ_RANGE_MAX, positiveInt(record.count, READ_RANGE_MAX)),
      },
    };
  }
  if (typeof record.answer === "string" && record.answer.trim()) {
    return { kind: "answer", answer: record.answer.trim() };
  }
  return { kind: "answer", answer: trimmed };
}

function positiveInt(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.floor(number);
}

export function clipAgentResult(text: string): string {
  if (text.length <= AGENT_RESULT_CHARS) return text;
  return `${text.slice(0, AGENT_RESULT_CHARS)}\n…已截断`;
}

export async function runReadAgent(input: {
  question: string;
  root: string;
  complete(messages: AiMessage[]): Promise<string>;
  tools: AgentTools;
  maxSteps?: number;
}): Promise<{ answer: string; trace: AgentTrace[] }> {
  const maxSteps = input.maxSteps ?? AGENT_MAX_STEPS;
  const messages: AiMessage[] = [
    { role: "system", content: agentSystem(input.root) },
    { role: "user", content: input.question.trim() },
  ];
  const trace: AgentTrace[] = [];
  for (let step = 0; step < maxSteps; step += 1) {
    const text = await input.complete(messages);
    const turn = parseAgentTurn(text);
    if (turn.kind === "answer") return { answer: turn.answer, trace };
    if (turn.kind === "empty") {
      messages.push({ role: "user", content: "请输出一个 JSON 对象。" });
      continue;
    }
    if (turn.kind === "rejected") {
      const result = `拒绝：没有「${turn.tool}」。只能列目录、搜索、按区间读、读大纲，不能改文件。`;
      trace.push({ name: turn.tool || "rejected", detail: "", result });
      messages.push({ role: "assistant", content: text });
      messages.push({ role: "user", content: result });
      continue;
    }
    const result = clipAgentResult(await dispatchTool(input.root, turn.call, input.tools));
    trace.push({
      name: turn.call.name,
      detail: turn.call.name === "grep" ? turn.call.pattern : turn.call.path,
      result,
    });
    messages.push({ role: "assistant", content: text });
    messages.push({
      role: "user",
      content: `工具结果：\n${result}\n若已经够用，输出 {"answer":"..."}。`,
    });
  }
  return { answer: "查找次数已用完，没有得出回答。文件没有被修改。", trace };
}

async function dispatchTool(root: string, call: AgentCall, tools: AgentTools): Promise<string> {
  const path = resolveWorkspacePath(root, call.path);
  if (!path) return "拒绝：路径不在工作区。";
  if (call.name === "list_dir") return tools.listDir(path);
  if (call.name === "grep") {
    const pattern = call.pattern.trim().slice(0, 80);
    if (!pattern) return "搜索内容不能为空。";
    return tools.grep(pattern, path);
  }
  if (call.name === "read_range") return tools.readRange(path, call.start, call.count);
  return tools.outline(path);
}
