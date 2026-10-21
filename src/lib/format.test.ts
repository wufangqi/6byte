import { describe, expect, it } from "vitest";
import { formatSize, formatTime } from "./format";

describe("formatSize", () => {
  it("formats raw bytes", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
  });

  it("formats kilobytes with one decimal", () => {
    expect(formatSize(1536)).toBe("1.5 KB");
  });

  it("formats megabytes with two decimals", () => {
    expect(formatSize(2 * 1024 * 1024)).toBe("2.00 MB");
  });
});

describe("formatTime", () => {
  it("returns a placeholder for a missing timestamp", () => {
    expect(formatTime(0)).toBe("未知");
  });

  it("formats a valid timestamp", () => {
    expect(formatTime(Date.UTC(2026, 0, 2, 3, 4, 5))).not.toBe("未知");
  });
});
