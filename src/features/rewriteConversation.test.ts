import { describe, expect, it } from "vitest";
import {
  appendRewriteTurn,
  followupRewriteMessages,
  REWRITE_HISTORY_LIMIT,
} from "./rewriteConversation";

describe("rewrite conversation", () => {
  it("keeps a small local history", () => {
    const turns = Array.from({ length: REWRITE_HISTORY_LIMIT + 2 }, (_, index) => ({
      instruction: `要求 ${index}`,
      proposal: `候选 ${index}`,
    })).reduce(appendRewriteTurn, []);
    expect(turns).toHaveLength(REWRITE_HISTORY_LIMIT);
    expect(turns[0]).toEqual({ instruction: "要求 2", proposal: "候选 2" });
    expect(turns.at(-1)).toEqual({ instruction: "要求 5", proposal: "候选 5" });
  });

  it("continues from the latest candidate while retaining the original context", () => {
    const messages = followupRewriteMessages(
      [
        { role: "system", content: "只输出改写" },
        { role: "user", content: "选区：原文\n要求：先润色" },
      ],
      "第一版候选",
      "再短一点",
      "引用：术语表"
    );
    expect(messages).toEqual([
      { role: "system", content: "只输出改写" },
      { role: "user", content: "选区：原文\n要求：先润色" },
      { role: "assistant", content: "第一版候选" },
      {
        role: "user",
        content:
          "请继续修改上面这版候选稿。只输出新的完整候选稿，不要解释。\n\n新要求：\n再短一点\n\n补充引用（仅供参考）：\n引用：术语表",
      },
    ]);
  });

  it("does not add an empty reference block", () => {
    const messages = followupRewriteMessages([], "候选", "改口语一点", "  ");
    expect(messages.at(-1)?.content).not.toContain("补充引用");
  });
});
