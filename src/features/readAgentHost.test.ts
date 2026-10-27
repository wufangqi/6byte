import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  aiCancel: vi.fn(async () => {}),
  aiStart: vi.fn(async () => "stream-1"),
  grepFiles: vi.fn(),
  listDirChildren: vi.fn(),
  openDocument: vi.fn(),
  readFile: vi.fn(),
  readRange: vi.fn(),
  statFile: vi.fn(),
  onAiToken: vi.fn(async () => () => {}),
  onAiDone: vi.fn(async () => () => {}),
  onAiError: vi.fn(async () => () => {}),
}));

vi.mock("../ipc/api", () => api);

import { deliverAiStreamEvent, resetAiStreamBusForTests } from "../ipc/aiStreamBus";
import { completeAgentTurn, workspaceAgentTools } from "./readAgentHost";

const ROOT = "D:\\repo";

describe("workspace agent tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAiStreamBusForTests();
  });

  it("drops hidden, key and listed names from a folder listing", async () => {
    api.listDirChildren.mockResolvedValue({
      truncated: false,
      limit: 100,
      entries: [
        { name: "README.md", path: "D:\\repo\\README.md", kind: "file" },
        { name: ".env", path: "D:\\repo\\.env", kind: "file" },
        { name: "server.pem", path: "D:\\repo\\server.pem", kind: "file" },
        { name: "private", path: "D:\\repo\\private", kind: "dir" },
        { name: "src", path: "D:\\repo\\src", kind: "dir" },
      ],
    });
    const listing = await workspaceAgentTools(ROOT, ["private"]).listDir(ROOT);
    expect(listing).toBe("file README.md\ndir src");
  });

  it("filters search hits that came from a hidden or key file", async () => {
    api.grepFiles.mockResolvedValue({
      matches: [
        { path: "D:\\repo\\.env", line: 1, column: 1, text: "API_KEY=abc" },
        { path: "D:\\repo\\certs\\a.pem", line: 2, column: 1, text: "-----BEGIN" },
        { path: "D:\\repo\\docs\\a.md", line: 3, column: 1, text: "API_KEY 在这里说明" },
      ],
      filesScanned: 3,
      filesMatched: 3,
      truncated: false,
      elapsedMs: 1,
    });
    const text = await workspaceAgentTools(ROOT).grep("API_KEY", ROOT);
    expect(text).toContain("docs\\a.md:3:");
    expect(text).not.toContain(".env");
    expect(text).not.toContain("BEGIN");
  });

  it("says there is no match when every hit was filtered out", async () => {
    api.grepFiles.mockResolvedValue({
      matches: [{ path: "D:\\repo\\.env", line: 1, column: 1, text: "API_KEY=abc" }],
      filesScanned: 1,
      filesMatched: 1,
      truncated: false,
      elapsedMs: 1,
    });
    expect(await workspaceAgentTools(ROOT).grep("API_KEY", ROOT)).toBe("没有匹配");
  });
});

describe("agent request cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAiStreamBusForTests();
  });

  const input = {
    baseUrl: "https://example.test/v1",
    model: "m",
    profileId: "p",
    messages: [{ role: "user" as const, content: "hi" }],
  };

  it("stops the request on the Rust side when aborted after it started", async () => {
    const controller = new AbortController();
    const turn = completeAgentTurn({ ...input, signal: controller.signal });
    await vi.waitFor(() => expect(api.aiStart).toHaveBeenCalled());
    await Promise.resolve();
    controller.abort();
    await expect(turn).rejects.toThrow("cancelled");
    expect(api.aiCancel).toHaveBeenCalledWith("stream-1");
  });

  it("stops a request whose id arrives after the abort", async () => {
    const controller = new AbortController();
    const turn = completeAgentTurn({ ...input, signal: controller.signal });
    controller.abort();
    await expect(turn).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(api.aiCancel).toHaveBeenCalledWith("stream-1"));
  });

  it("does not start at all when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(completeAgentTurn({ ...input, signal: controller.signal })).rejects.toThrow(
      "cancelled"
    );
    expect(api.aiStart).not.toHaveBeenCalled();
  });

  it("still returns the reply when it was not aborted", async () => {
    const turn = completeAgentTurn(input);
    await vi.waitFor(() => expect(api.aiStart).toHaveBeenCalled());
    await vi.waitFor(() => {
      deliverAiStreamEvent({
        type: "token",
        event: { streamId: "stream-1", kind: "content", delta: "好" },
      });
      deliverAiStreamEvent({ type: "done", event: { streamId: "stream-1" } });
    });
    await expect(turn).resolves.toEqual({ text: "好", toolCalls: [] });
    expect(api.aiStart).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.arrayContaining([expect.objectContaining({ type: "function" })]),
      })
    );
  });

  it("returns native tool calls without treating them as answer text", async () => {
    const turn = completeAgentTurn(input);
    await vi.waitFor(() => expect(api.aiStart).toHaveBeenCalled());
    deliverAiStreamEvent({
      type: "done",
      event: {
        streamId: "stream-1",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "outline", arguments: '{"path":"README.md"}' },
          },
        ],
      },
    });
    await expect(turn).resolves.toEqual({
      text: "",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "outline", arguments: '{"path":"README.md"}' },
        },
      ],
    });
  });
});
