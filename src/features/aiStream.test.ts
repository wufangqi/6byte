import { describe, expect, it } from "vitest";
import { CATALOGS } from "../i18n/messages";
import {
  IDLE_STREAM,
  modelHost,
  outgoingChars,
  QUICK_ACTIONS,
  quickActionMessages,
  reduceStream,
  selectionTooLarge,
  SELECTION_CHAR_LIMIT,
  streamMessages,
} from "./aiStream";

describe("model stream request", () => {
  it("shows the host the characters will be sent to", () => {
    expect(modelHost("http://127.0.0.1:11434/v1")).toBe("127.0.0.1:11434");
    expect(modelHost("https://api.openai.com/v1/")).toBe("api.openai.com");
    expect(modelHost("not a url")).toBe("not a url");
  });

  it("sends the selection and the instruction, not a surrounding document", () => {
    const messages = streamMessages("原文", "改短");
    expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(messages[1].content).toContain("原文");
    expect(messages[1].content).toContain("改短");
    expect(messages[1].content).not.toContain("整篇");
    expect(outgoingChars(messages)).toBe(messages[0].content.length + messages[1].content.length);
  });

  it("refuses a selection above the character limit", () => {
    expect(selectionTooLarge("a".repeat(SELECTION_CHAR_LIMIT))).toBe(false);
    expect(selectionTooLarge("a".repeat(SELECTION_CHAR_LIMIT + 1))).toBe(true);
  });
});

describe("quick actions", () => {
  it("offers polish, translate and summarize with distinct prompts", () => {
    expect(QUICK_ACTIONS.map((action) => action.id)).toEqual(["polish", "translate", "summarize"]);
    expect(new Set(QUICK_ACTIONS.map((action) => action.promptKey)).size).toBe(3);
  });

  it("resolves every label and prompt in both locales", () => {
    for (const action of QUICK_ACTIONS) {
      for (const catalog of [CATALOGS.zh, CATALOGS.en]) {
        expect(catalog[action.labelKey], action.labelKey).toBeTruthy();
        expect(catalog[action.promptKey], action.promptKey).toBeTruthy();
      }
    }
  });

  it("sends the action prompt together with the selection", () => {
    const prompt = CATALOGS.zh[QUICK_ACTIONS[0].promptKey];
    const messages = quickActionMessages("原文", prompt);
    expect(messages[0].role).toBe("system");
    expect(messages[1].content).toContain("原文");
    expect(messages[1].content).toContain(prompt);
  });
});

describe("stream view", () => {
  it("appends tokens and then finishes", () => {
    const waiting = reduceStream(IDLE_STREAM, { type: "start" });
    const first = reduceStream(waiting, { type: "delta", delta: "你" });
    const second = reduceStream(first, { type: "delta", delta: "好" });
    const done = reduceStream(second, { type: "done" });
    expect(done).toEqual({ phase: "done", text: "你好", thinking: "", error: null });
    expect(reduceStream(done, { type: "error", message: "late" })).toBe(done);
  });

  it("drops a partial reply when cancelled", () => {
    const streaming = reduceStream(reduceStream(IDLE_STREAM, { type: "start" }), {
      type: "delta",
      delta: "半截",
    });
    const cancelled = reduceStream(streaming, { type: "cancel" });
    expect(cancelled).toEqual({ phase: "cancelled", text: "", thinking: "", error: null });
    expect(reduceStream(cancelled, { type: "delta", delta: "更多" })).toBe(cancelled);
  });

  it("keeps the partial reply when the request fails", () => {
    const streaming = reduceStream(reduceStream(IDLE_STREAM, { type: "start" }), {
      type: "delta",
      delta: "半截",
    });
    expect(reduceStream(streaming, { type: "error", message: "服务返回 500：down" })).toEqual({
      phase: "error",
      text: "半截",
      thinking: "",
      error: "服务返回 500：down",
    });
  });

  it("keeps thinking separate from the rewrite", () => {
    const waiting = reduceStream(IDLE_STREAM, { type: "start" });
    const thinking = reduceStream(waiting, { type: "delta", kind: "reasoning", delta: "先想" });
    const answer = reduceStream(thinking, { type: "delta", delta: "结果" });
    expect(answer).toEqual({ phase: "streaming", text: "结果", thinking: "先想", error: null });
  });
});
