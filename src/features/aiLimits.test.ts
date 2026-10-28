// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  AI_LIMITS_KEY,
  ContextOverflowError,
  DEFAULT_LIMITS_STORE,
  MAX_CUSTOM_LIMITS,
  MIN_REPLY_TOKENS,
  PRESET_LIMITS,
  activeLimits,
  addCustomLimits,
  applyLimits,
  clampLimit,
  estimateTokens,
  limitsOf,
  messageTokens,
  parseLimitsStore,
  removeCustomLimits,
  replyTokens,
  saveLimitsStore,
  updateCustomLimits,
  type LimitsStore,
} from "./aiLimits";

beforeEach(() => localStorage.clear());

describe("limits store", () => {
  it("falls back to the medium preset for missing or broken data", () => {
    expect(parseLimitsStore(null)).toEqual(DEFAULT_LIMITS_STORE);
    expect(parseLimitsStore("{oops")).toEqual(DEFAULT_LIMITS_STORE);
    expect(parseLimitsStore(JSON.stringify({ activeId: "gone", custom: [] })).activeId).toBe(
      "balanced"
    );
  });

  it("clamps stored values and keeps at most five custom sets", () => {
    const custom = Array.from({ length: 7 }, (_, index) => ({
      id: `c${index}`,
      name: ` set ${index} `,
      limits: { historyTurns: 99, askSteps: -3 },
    }));
    const store = parseLimitsStore(JSON.stringify({ activeId: "c1", custom }));
    expect(store.custom).toHaveLength(MAX_CUSTOM_LIMITS);
    expect(store.activeId).toBe("c1");
    expect(store.custom[0].name).toBe("set 0");
    expect(store.custom[0].limits.historyTurns).toBe(20);
    expect(store.custom[0].limits.askSteps).toBe(1);
    expect(store.custom[0].limits.selectionChars).toBe(PRESET_LIMITS.balanced.selectionChars);
  });

  it("clamps a single value into its range", () => {
    expect(clampLimit("historyTurns", 3.6)).toBe(4);
    expect(clampLimit("selectionChars", 10)).toBe(500);
    expect(clampLimit("askBudget", Number.NaN)).toBe(PRESET_LIMITS.balanced.askBudget);
  });

  it("adds, edits, applies and removes custom sets", () => {
    let store: LimitsStore = DEFAULT_LIMITS_STORE;
    for (let index = 0; index < MAX_CUSTOM_LIMITS; index += 1) {
      store = addCustomLimits(store, `s${index}`, PRESET_LIMITS.max)!;
    }
    expect(addCustomLimits(store, "one too many", PRESET_LIMITS.max)).toBeNull();
    const id = store.custom[2].id;
    store = applyLimits(store, id);
    store = updateCustomLimits(store, id, { limits: { historyTurns: 500 } });
    expect(limitsOf(store).historyTurns).toBe(20);
    expect(PRESET_LIMITS.max.historyTurns).toBe(10);
    expect(applyLimits(store, "missing")).toBe(store);
    store = removeCustomLimits(store, id);
    expect(store.activeId).toBe("balanced");
    expect(store.custom).toHaveLength(MAX_CUSTOM_LIMITS - 1);
  });

  it("persists the active set", () => {
    saveLimitsStore(applyLimits(DEFAULT_LIMITS_STORE, "simple"));
    expect(localStorage.getItem(AI_LIMITS_KEY)).toContain("simple");
    expect(activeLimits()).toEqual(PRESET_LIMITS.simple);
  });
});

describe("token fitting", () => {
  it("counts CJK characters one each and other text by four", () => {
    expect(estimateTokens("你好世界")).toBe(4);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(messageTokens([{ role: "user", content: "abcd" }])).toBe(5);
  });

  it("leaves the output limit alone without a context length", () => {
    expect(replyTokens(100_000, 4096)).toBe(4096);
  });

  it("shrinks the output to what is left of the window", () => {
    expect(replyTokens(1000, 4096, 8192)).toBe(4096);
    expect(replyTokens(7000, 4096, 8192)).toBe(1192);
    expect(() => replyTokens(8192 - MIN_REPLY_TOKENS + 1, 4096, 8192)).toThrow(
      ContextOverflowError
    );
  });
});
