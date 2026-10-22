import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPLIT_PERCENT,
  MAX_SPLIT_PERCENT,
  MIN_SPLIT_PERCENT,
  SPLIT_KEYBOARD_STEP,
  adjustSplitPercent,
  clampSplitPercent,
  normalizeSplitPercent,
} from "./splitPane";

describe("clampSplitPercent", () => {
  it("maps the pointer position to a percentage of the container", () => {
    expect(clampSplitPercent(500, 0, 1000)).toBe(50);
    expect(clampSplitPercent(300, 100, 1000)).toBe(20);
  });

  it("clamps to the allowed range", () => {
    expect(clampSplitPercent(-100, 0, 1000)).toBe(MIN_SPLIT_PERCENT);
    expect(clampSplitPercent(2000, 0, 1000)).toBe(MAX_SPLIT_PERCENT);
  });

  it("falls back to the default for an unmeasured container", () => {
    expect(clampSplitPercent(100, 0, 0)).toBe(DEFAULT_SPLIT_PERCENT);
  });
});

describe("adjustSplitPercent", () => {
  it("steps within the allowed range", () => {
    expect(adjustSplitPercent(50, SPLIT_KEYBOARD_STEP)).toBe(53);
    expect(adjustSplitPercent(50, -SPLIT_KEYBOARD_STEP)).toBe(47);
  });

  it("never leaves the range", () => {
    expect(adjustSplitPercent(MIN_SPLIT_PERCENT, -10)).toBe(MIN_SPLIT_PERCENT);
    expect(adjustSplitPercent(MAX_SPLIT_PERCENT, 10)).toBe(MAX_SPLIT_PERCENT);
  });
});

describe("normalizeSplitPercent", () => {
  it("keeps valid values", () => {
    expect(normalizeSplitPercent(65)).toBe(65);
  });

  it("falls back for missing or invalid values", () => {
    expect(normalizeSplitPercent(Number.NaN)).toBe(DEFAULT_SPLIT_PERCENT);
    expect(normalizeSplitPercent(0)).toBe(MIN_SPLIT_PERCENT);
    expect(normalizeSplitPercent(100)).toBe(MAX_SPLIT_PERCENT);
  });
});
