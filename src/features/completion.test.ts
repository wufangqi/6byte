import { describe, expect, it } from "vitest";
import { completionMessages, completionSlice, visibleSuggestion } from "./completion";
import { completionEndpoint, parseCompletionSettings } from "./completionSettings";
import type { AiCatalog } from "./aiSettings";

const catalog: AiCatalog = {
  activeProviderId: "p1",
  activeModelId: "rewrite",
  providers: [
    {
      id: "p1",
      name: "云端",
      baseUrl: "https://example.com/v1",
      models: [
        { id: "rewrite", name: "改写", model: "thinker", enabled: true },
        { id: "fast", name: "补全", model: "fast-text", enabled: true },
      ],
    },
  ],
};

describe("completion settings", () => {
  it("stays off unless the stored switch is exactly true", () => {
    expect(parseCompletionSettings(null)).toEqual({
      enabled: false,
      providerId: "",
      modelId: "",
      delayMs: 500,
    });
    expect(parseCompletionSettings('{"enabled":"yes"}').enabled).toBe(false);
    expect(parseCompletionSettings('{"enabled":true,"providerId":"p1","modelId":"fast"}')).toEqual({
      enabled: true,
      providerId: "p1",
      modelId: "fast",
      delayMs: 500,
    });
    expect(parseCompletionSettings('{"enabled":true,"delayMs":50}').delayMs).toBe(100);
    expect(parseCompletionSettings('{"enabled":true,"delayMs":9000}').delayMs).toBe(5000);
  });

  it("uses the completion model, not the rewrite model", () => {
    const endpoint = completionEndpoint(catalog, {
      enabled: true,
      providerId: "p1",
      modelId: "fast",
      delayMs: 500,
    });
    expect(endpoint).toEqual({
      id: "p1",
      baseUrl: "https://example.com/v1",
      model: "fast-text",
    });
    expect(
      completionEndpoint(catalog, {
        enabled: true,
        providerId: "p1",
        modelId: "missing",
        delayMs: 500,
      })
    ).toBeNull();
  });
});

describe("completion text", () => {
  it("asks only for the continuation and ignores a thinking trace in the prompt", () => {
    const slice = completionSlice("他走进了客栈", 6);
    expect(slice?.prefix).toBe("他走进了客栈");
    const messages = completionMessages(slice!.prefix, "");
    expect(messages[0].content).toContain("不要思考过程");
    expect(messages[1].content).toContain("他走进了客栈");
  });

  it("keeps one sentence and drops an echoed prefix", () => {
    expect(visibleSuggestion("他走进了客栈", "他走进了客栈，要了一壶酒。然后又点了菜。")).toBe(
      "，要了一壶酒。"
    );
    expect(visibleSuggestion("他说", "下一句\n不要这行")).toBe("下一句");
  });

  it("refuses a tiny prefix", () => {
    expect(completionSlice("你好", 2)).toBeNull();
  });

  it("copies only the window around the caret", () => {
    const calls: Array<[number, number]> = [];
    const doc = {
      length: 20_000_000,
      sliceString(from: number, to: number) {
        calls.push([from, to]);
        return "字".repeat(to - from);
      },
    };
    const slice = completionSlice(doc, 10_000);
    expect(calls).toEqual([
      [10_000 - 1_600, 10_000],
      [10_000, 10_000 + 240],
    ]);
    expect(slice?.prefix).toHaveLength(1_600);
    expect(slice?.suffix).toHaveLength(240);
  });
});
