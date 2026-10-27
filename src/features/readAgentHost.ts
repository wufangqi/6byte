import { abandonAiStream, claimAiStream } from "../ipc/aiStreamBus";
import { blockedReason } from "./agentAccess";
import {
  recordAiCancellation,
  recordAiFailure,
  recordAiFirstToken,
  recordAiRequest,
  recordAiSuccess,
} from "./aiMetrics";
import {
  aiCancel,
  aiStart,
  grepFiles,
  listDirChildren,
  openDocument,
  readFile,
  readRange,
  statFile,
} from "../ipc/api";
import type { AiMessage, AiToolCall, AiUsage } from "../ipc/types";
import { extractHeadings } from "./outline";
import {
  AGENT_TOOL_DEFINITIONS,
  READ_RANGE_MAX,
  type AgentCompletion,
  type AgentTools,
} from "./readAgent";

const OUTLINE_BYTE_CAP = 256 * 1024;
const OUTLINE_FALLBACK_LINES = 200;
const LIST_CAP = 80;
const GREP_CAP = 20;

function clipLine(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

async function linesOf(path: string, start: number, count: number): Promise<string[]> {
  const bounded = Math.min(READ_RANGE_MAX, Math.max(1, count));
  const from = Math.max(1, start);
  try {
    const stat = await statFile(path);
    if (stat.size <= OUTLINE_BYTE_CAP) {
      const file = await readFile(path);
      return file.content.split(/\r?\n/).slice(from - 1, from - 1 + bounded);
    }
  } catch {
    /* Fall through to the large-file range reader. */
  }
  await openDocument(path);
  const range = await readRange(path, from - 1, from - 1 + bounded);
  return range.lines;
}

/**
 * Workspace tools. Callers must pass paths already confined to the workspace.
 * Listings and search hits are filtered again here: the Rust walk skips hidden
 * folders but still searches a hidden or key file that sits in a normal folder.
 */
export function workspaceAgentTools(root: string, denylist: readonly string[] = []): AgentTools {
  const allowed = (path: string) => blockedReason(root, path, denylist) === null;
  return {
    async listDir(path) {
      const listing = await listDirChildren(path);
      const visible = listing.entries.filter((entry) => allowed(entry.path));
      const lines = visible.slice(0, LIST_CAP).map((entry) => `${entry.kind} ${entry.name}`);
      const more = visible.length > LIST_CAP || listing.truncated ? "\n…还有更多" : "";
      return `${lines.join("\n")}${more}`;
    },
    async grep(pattern, path) {
      const result = await grepFiles(path, pattern, false, GREP_CAP);
      const matches = result.matches.filter((match) => allowed(match.path));
      if (matches.length === 0) return "没有匹配";
      return matches
        .map((match) => `${match.path}:${match.line}:${clipLine(match.text)}`)
        .join("\n");
    },
    async readRange(path, start, count) {
      const lines = await linesOf(path, start, count);
      if (lines.length === 0) return "这个区间没有内容。";
      return lines.map((line, index) => `${start + index}|${clipLine(line)}`).join("\n");
    },
    async outline(path) {
      const stat = await statFile(path);
      const content =
        stat.size <= OUTLINE_BYTE_CAP
          ? (await readFile(path)).content
          : (await linesOf(path, 1, OUTLINE_FALLBACK_LINES)).join("\n");
      const headings = extractHeadings(content).slice(0, 80);
      if (headings.length === 0) {
        return stat.size > OUTLINE_BYTE_CAP ? "前 200 行里没有标题。" : "没有标题。";
      }
      const text = headings
        .map((heading) => `${heading.line} ${"#".repeat(heading.level)} ${heading.text}`)
        .join("\n");
      return stat.size > OUTLINE_BYTE_CAP ? `${text}\n（只看了前 200 行）` : text;
    },
  };
}

/**
 * One model turn for the read-only loop. The reply is not written into the document.
 * Aborting stops the request on the Rust side and rejects.
 */
export function completeAgentTurn(input: {
  baseUrl: string;
  model: string;
  profileId: string;
  messages: AiMessage[];
  signal?: AbortSignal;
}): Promise<AgentCompletion> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const startedAt = performance.now();
    let firstToken = false;
    recordAiRequest("ask");
    let text = "";
    let toolCalls: AiToolCall[] = [];
    let settled = false;
    let streamId: string | null = null;
    const finish = (
      error?: Error,
      outcome: "success" | "failed" | "cancelled" = error ? "failed" : "success",
      usage?: AiUsage
    ) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", onAbort);
      claim.release();
      if (outcome === "success") recordAiSuccess("ask", usage);
      else if (outcome === "failed") recordAiFailure("ask");
      else recordAiCancellation("ask");
      if (error) reject(error);
      else resolve({ text, toolCalls });
    };
    const onAbort = () => {
      if (streamId) void aiCancel(streamId).catch(() => {});
      finish(new Error("cancelled"), "cancelled");
    };
    const claim = claimAiStream({
      token(event) {
        if (!firstToken) {
          firstToken = true;
          recordAiFirstToken("ask", performance.now() - startedAt);
        }
        if (event.kind === "reasoning") return;
        text += event.delta;
      },
      done(event) {
        if (!firstToken && event.toolCalls?.length) {
          firstToken = true;
          recordAiFirstToken("ask", performance.now() - startedAt);
        }
        toolCalls = event.toolCalls ?? [];
        finish(undefined, "success", event.usage);
      },
      error(event) {
        finish(new Error(event.message), "failed");
      },
    });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    void aiStart({
      providerId: "openai-compatible",
      baseUrl: input.baseUrl,
      model: input.model,
      profileId: input.profileId,
      maxTokens: 1024,
      messages: input.messages,
      tools: AGENT_TOOL_DEFINITIONS,
    })
      .then((id) => {
        if (settled) {
          // Cancelled before the id came back: stop it and drop its events.
          abandonAiStream(id);
          void aiCancel(id).catch(() => {});
          return;
        }
        streamId = id;
        claim.bind(id);
      })
      .catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error(String(error)), "failed");
      });
  });
}
