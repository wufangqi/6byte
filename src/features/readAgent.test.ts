import { describe, expect, it } from "vitest";
import { parseAgentTurn, resolveWorkspacePath, runReadAgent, type AgentTools } from "./readAgent";

const tools = (): AgentTools & { calls: string[] } => ({
  calls: [],
  async listDir(path) {
    this.calls.push(`list:${path}`);
    return "readme.md";
  },
  async grep(pattern) {
    this.calls.push(`grep:${pattern}`);
    return "readme.md:1:hello";
  },
  async readRange(path, start, count) {
    this.calls.push(`read:${path}:${start}:${count}`);
    return "1|hello";
  },
  async outline(path) {
    this.calls.push(`outline:${path}`);
    return "# 安装";
  },
});

describe("read-only agent", () => {
  it("keeps paths inside the workspace", () => {
    expect(resolveWorkspacePath("D:/repo", "src/app.ts")).toBe("D:\\repo\\src\\app.ts");
    expect(resolveWorkspacePath("D:/repo", ".")).toBe("D:\\repo");
    expect(resolveWorkspacePath("D:/repo", "../secret")).toBeNull();
    expect(resolveWorkspacePath("D:/repo", "D:/other/a.txt")).toBeNull();
    expect(resolveWorkspacePath("D:/repo", "D:/repo/src/app.ts")).toBe("D:\\repo\\src\\app.ts");
  });

  it("accepts the four read tools and rejects a write", () => {
    expect(parseAgentTurn('{"tool":"outline","path":"readme.md"}').kind).toBe("call");
    expect(parseAgentTurn('{"answer":"安装用 pnpm。"}')).toEqual({
      kind: "answer",
      answer: "安装用 pnpm。",
    });
    expect(parseAgentTurn('{"tool":"write","path":"readme.md"}')).toEqual({
      kind: "rejected",
      tool: "write",
    });
    const range = parseAgentTurn('{"tool":"read_range","path":"a.txt","start":2,"count":500}');
    expect(range.kind === "call" && range.call.count).toBe(40);
  });

  it("looks up with a tool, then answers, and never calls a write", async () => {
    const client = tools();
    const replies = ['{"tool":"outline","path":"readme.md"}', '{"answer":"安装一节讲 pnpm。"}'];
    const result = await runReadAgent({
      question: "安装说明写了什么？",
      root: "D:/repo",
      tools: client,
      complete: async () => replies.shift() ?? '{"answer":"没有"}',
    });
    expect(client.calls).toEqual(["outline:D:\\repo\\readme.md"]);
    expect(result.answer).toBe("安装一节讲 pnpm。");
    expect(result.trace.map((step) => step.name)).toEqual(["outline"]);
    expect(client.calls.some((call) => call.startsWith("write"))).toBe(false);
  });

  it("refuses a write tool and still does not touch files", async () => {
    const client = tools();
    const replies = ['{"tool":"write","path":"readme.md"}', '{"answer":"不能改文件。"}'];
    const result = await runReadAgent({
      question: "把 readme 改掉",
      root: "D:/repo",
      tools: client,
      complete: async () => replies.shift() ?? '{"answer":"停"}',
    });
    expect(client.calls).toEqual([]);
    expect(result.trace[0]?.result).toContain("不能改文件");
    expect(result.answer).toBe("不能改文件。");
  });

  it("stops after the step cap without a final answer", async () => {
    const client = tools();
    const result = await runReadAgent({
      question: "继续找",
      root: "D:/repo",
      tools: client,
      maxSteps: 2,
      complete: async () => '{"tool":"list_dir","path":"."}',
    });
    expect(client.calls).toHaveLength(2);
    expect(result.answer).toContain("没有得出回答");
    expect(result.answer).toContain("没有被修改");
  });
});
