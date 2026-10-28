import { describe, expect, it } from "vitest";
import {
  appendRewriteTurn,
  REWRITE_TURNS_KEPT,
  rewriteFollowupMessages,
  type RewriteTurn,
} from "./rewriteConversation";

const base = [
  { role: "system" as const, content: "只输出改写" },
  { role: "user" as const, content: "选区：原文\n要求：先润色" },
];

const rounds = (count: number): RewriteTurn[] =>
  Array.from({ length: count }, (_, index) => ({
    instruction: `要求 ${index}`,
    proposal: `候选 ${index}`,
  }));

const prompt = (instruction: string, references = "") =>
  `请继续修改上面这版候选稿。只输出新的完整候选稿，不要解释。\n\n新要求：\n${instruction}${
    references ? `\n\n补充引用（仅供参考）：\n${references}` : ""
  }`;

describe("rewrite conversation", () => {
  it("keeps a bounded local history", () => {
    const turns = rounds(REWRITE_TURNS_KEPT + 2).reduce<RewriteTurn[]>(
      (list, turn) => appendRewriteTurn(list, turn),
      []
    );
    expect(turns).toHaveLength(REWRITE_TURNS_KEPT);
    expect(turns.at(-1)).toEqual({
      instruction: `要求 ${REWRITE_TURNS_KEPT + 1}`,
      proposal: `候选 ${REWRITE_TURNS_KEPT + 1}`,
    });
  });

  it("replays earlier rounds in order", () => {
    const messages = rewriteFollowupMessages({
      base,
      turns: rounds(2),
      instruction: "再短一点",
      references: "引用：术语表",
      historyTurns: 4,
      historyChars: 10_000,
    });
    expect(messages).toEqual([
      ...base,
      { role: "assistant", content: "候选 0" },
      { role: "user", content: prompt("要求 1") },
      { role: "assistant", content: "候选 1" },
      { role: "user", content: prompt("再短一点", "引用：术语表") },
    ]);
  });

  it("always keeps the latest draft, even with no history", () => {
    const messages = rewriteFollowupMessages({
      base,
      turns: rounds(3),
      instruction: "改口语一点",
      references: "  ",
      historyTurns: 0,
      historyChars: 0,
    });
    expect(messages).toEqual([
      ...base,
      { role: "assistant", content: "候选 2" },
      { role: "user", content: prompt("改口语一点") },
    ]);
  });

  it("drops the oldest rounds over the character limit", () => {
    const turns = [
      { instruction: "a", proposal: "x".repeat(50) },
      { instruction: "b", proposal: "y".repeat(50) },
      { instruction: "c", proposal: "z".repeat(50) },
    ];
    const messages = rewriteFollowupMessages({
      base,
      turns,
      instruction: "next",
      historyTurns: 10,
      historyChars: 120,
    });
    const assistant = messages.filter((message) => message.role === "assistant");
    expect(assistant.map((message) => message.content[0])).toEqual(["y", "z"]);
  });

  it("drops rounds that do not fit the model window", () => {
    const turns = rounds(5).map((turn) => ({ ...turn, proposal: "长".repeat(200) }));
    const messages = rewriteFollowupMessages({
      base,
      turns,
      instruction: "next",
      historyTurns: 10,
      historyChars: 100_000,
      contextTokens: 900,
    });
    const assistant = messages.filter((message) => message.role === "assistant");
    expect(assistant.length).toBeGreaterThanOrEqual(1);
    expect(assistant.length).toBeLessThan(5);
  });
});
