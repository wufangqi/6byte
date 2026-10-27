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

  it("uses a native tool call when the provider returns one", async () => {
    const client = tools();
    const turns: unknown[] = [];
    const result = await runReadAgent({
      question: "安装说明写了什么？",
      root: "D:/repo",
      tools: client,
      complete: async (messages) => {
        turns.push(messages);
        return turns.length === 1
          ? {
              text: "",
              toolCalls: [
                {
                  id: "call-1",
                  type: "function" as const,
                  function: { name: "outline", arguments: '{"path":"readme.md"}' },
                },
              ],
            }
          : { text: '{"answer":"安装一节讲 pnpm。"}' };
      },
    });

    expect(client.calls).toEqual(["outline:D:\\repo\\readme.md"]);
    expect(result.answer).toBe("安装一节讲 pnpm。");
    expect(turns[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          toolCalls: [expect.objectContaining({ id: "call-1" })],
        }),
        expect.objectContaining({ role: "tool", toolCallId: "call-1" }),
      ])
    );
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
    expect(result.stop).toBe("steps");
  });

  it("refuses hidden, key and listed files and tells the model why", async () => {
    const client = tools();
    const replies = [
      '{"tool":"read_range","path":".env","start":1,"count":5}',
      '{"tool":"outline","path":"certs/server.pem"}',
      '{"tool":"read_range","path":"private/a.md"}',
      '{"tool":"list_dir","path":".git"}',
      '{"answer":"读不到。"}',
    ];
    const result = await runReadAgent({
      question: "密钥是什么？",
      root: "D:/repo",
      tools: client,
      maxSteps: 5,
      denylist: ["private"],
      complete: async () => replies.shift() ?? '{"answer":"停"}',
    });
    expect(client.calls).toEqual([]);
    expect(result.trace).toHaveLength(4);
    expect(result.trace.every((step) => step.result.startsWith("拒绝"))).toBe(true);
    expect(result.answer).toBe("读不到。");
  });

  it("still reads an ordinary file next to the refused ones", async () => {
    const client = tools();
    const replies = ['{"tool":"read_range","path":"docs/a.md"}', '{"answer":"好"}'];
    await runReadAgent({
      question: "看一下",
      root: "D:/repo",
      tools: client,
      denylist: ["private"],
      complete: async () => replies.shift() ?? '{"answer":"停"}',
    });
    expect(client.calls).toEqual(["read:D:\\repo\\docs\\a.md:1:40"]);
  });

  it("counts every request and stops before one would pass the budget", async () => {
    const client = tools();
    const seen: number[] = [];
    const result = await runReadAgent({
      question: "继续找",
      root: "D:/repo",
      tools: client,
      budget: 900,
      onProgress: (progress) => seen.push(progress.sent),
      complete: async () => '{"tool":"list_dir","path":"."}',
    });
    expect(result.stop).toBe("budget");
    expect(result.answer).toContain("发送上限");
    expect(result.answer).toContain("没有被修改");
    expect(result.sent).toBeLessThanOrEqual(900);
    expect(result.sent).toBeGreaterThan(0);
    // Each request resends the whole conversation, so the total grows each step.
    const sizes = seen.filter((value, index) => index === 0 || value !== seen[index - 1]);
    expect(sizes.length).toBeGreaterThan(1);
    expect(client.calls.length).toBeLessThan(4);
  });

  it("sends nothing when the question alone exceeds the budget", async () => {
    let requests = 0;
    const result = await runReadAgent({
      question: "很长".repeat(500),
      root: "D:/repo",
      tools: tools(),
      budget: 300,
      complete: async () => {
        requests += 1;
        return '{"answer":"x"}';
      },
    });
    expect(requests).toBe(0);
    expect(result.sent).toBe(0);
    expect(result.stop).toBe("budget");
  });

  it("cancels in the middle of a request and does not send the next one", async () => {
    const controller = new AbortController();
    const client = tools();
    let requests = 0;
    const result = await runReadAgent({
      question: "找一下",
      root: "D:/repo",
      tools: client,
      signal: controller.signal,
      complete: (_messages, signal) => {
        requests += 1;
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("cancelled")));
          controller.abort();
        });
      },
    });
    expect(requests).toBe(1);
    expect(result.stop).toBe("cancelled");
    expect(result.answer).toContain("已取消");
    expect(client.calls).toEqual([]);
  });

  it("does not run a tool whose request finished after the user cancelled", async () => {
    const controller = new AbortController();
    const client = tools();
    const result = await runReadAgent({
      question: "找一下",
      root: "D:/repo",
      tools: client,
      signal: controller.signal,
      complete: async () => {
        controller.abort();
        return '{"tool":"list_dir","path":"."}';
      },
    });
    expect(result.stop).toBe("cancelled");
    expect(client.calls).toEqual([]);
  });

  it("does not start when it was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    let requests = 0;
    const result = await runReadAgent({
      question: "找一下",
      root: "D:/repo",
      tools: tools(),
      signal: controller.signal,
      complete: async () => {
        requests += 1;
        return "{}";
      },
    });
    expect(requests).toBe(0);
    expect(result.stop).toBe("cancelled");
    expect(result.sent).toBe(0);
  });

  it("still surfaces a real failure when it was not cancelled", async () => {
    await expect(
      runReadAgent({
        question: "找一下",
        root: "D:/repo",
        tools: tools(),
        complete: async () => {
          throw new Error("网络断了");
        },
      })
    ).rejects.toThrow("网络断了");
  });
});
