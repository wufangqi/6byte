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
        { id: "rewrite", name: "改写", model: "thinker" },
        { id: "fast", name: "补全", model: "fast-text" },
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
    });
    expect(parseCompletionSettings('{"enabled":"yes"}').enabled).toBe(false);
    expect(parseCompletionSettings('{"enabled":true,"providerId":"p1","modelId":"fast"}')).toEqual({
      enabled: true,
      providerId: "p1",
      modelId: "fast",
    });
  });

  it("uses the completion model, not the rewrite model", () => {
    const endpoint = completionEndpoint(catalog, {
      enabled: true,
      providerId: "p1",
      modelId: "fast",
    });
    expect(endpoint).toEqual({
      id: "p1",
      baseUrl: "https://example.com/v1",
      model: "fast-text",
    });
    expect(
      completionEndpoint(catalog, { enabled: true, providerId: "p1", modelId: "missing" })
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
});
