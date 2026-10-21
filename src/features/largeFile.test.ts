import { describe, expect, it } from "vitest";
import {
  LINE_HEIGHT,
  WINDOW_LINES,
  firstVisibleLine,
  needsFetch,
  windowStartFor,
} from "./largeFile";

describe("firstVisibleLine", () => {
  it("maps scroll offset to a 0-based line", () => {
    expect(firstVisibleLine(0)).toBe(0);
    expect(firstVisibleLine(LINE_HEIGHT * 3 + 5)).toBe(3);
  });

  it("never returns a negative line", () => {
    expect(firstVisibleLine(-40)).toBe(0);
  });
});

describe("windowStartFor", () => {
  it("centres the window around the viewport", () => {
    const start = windowStartFor(LINE_HEIGHT * 10_000, 1_000_000);
    expect(start).toBe(10_000 - WINDOW_LINES / 2);
  });

  it("clamps to the start and to the last full window", () => {
    expect(windowStartFor(0, 1_000_000)).toBe(0);
    // Near EOF the window start saturates at total - WINDOW_LINES.
    expect(windowStartFor(LINE_HEIGHT * 999_999, 1_000_000)).toBe(999_600);
    expect(windowStartFor(LINE_HEIGHT * 500, 600)).toBe(200);
  });

  it("never returns a negative start for tiny files", () => {
    expect(windowStartFor(LINE_HEIGHT * 100, 5)).toBe(0);
  });
});

describe("needsFetch", () => {
  it("does not refetch while the loaded window covers the viewport", () => {
    expect(needsFetch(0, 0, WINDOW_LINES, 1_000_000)).toBe(false);
    expect(needsFetch(LINE_HEIGHT * 100, 0, WINDOW_LINES, 1_000_000)).toBe(false);
  });

  it("refetches when scrolling past the loaded window", () => {
    // 500 is beyond windowStart 0 + 400 loaded + 80 overscan.
    expect(needsFetch(LINE_HEIGHT * 500, 0, WINDOW_LINES, 1_000_000)).toBe(true);
    expect(needsFetch(LINE_HEIGHT * 100, 500, WINDOW_LINES, 1_000_000)).toBe(true);
  });

  it("handles an empty document", () => {
    expect(needsFetch(0, 0, 0, 0)).toBe(false);
  });

  it("refetches when the viewport outgrows a short loaded window", () => {
    // Only 100 lines are loaded; the last visible row (150 + 48) exceeds
    // windowStart + loaded + overscan even though the top is still covered.
    expect(needsFetch(LINE_HEIGHT * 150, 0, 100, 1_000_000)).toBe(true);
  });
});
