import { describe, expect, it } from "vitest";
import { scrollFraction, topForFraction } from "./scrollSync";

describe("scrollFraction", () => {
  it("maps the scroll range to 0–1", () => {
    expect(scrollFraction({ top: 0, height: 1000, client: 200 })).toBe(0);
    expect(scrollFraction({ top: 400, height: 1000, client: 200 })).toBe(0.5);
    expect(scrollFraction({ top: 800, height: 1000, client: 200 })).toBe(1);
  });

  it("returns 0 when the content fits the viewport", () => {
    expect(scrollFraction({ top: 0, height: 300, client: 400 })).toBe(0);
  });

  it("clamps out-of-range input", () => {
    expect(scrollFraction({ top: -50, height: 1000, client: 200 })).toBe(0);
    expect(scrollFraction({ top: 5000, height: 1000, client: 200 })).toBe(1);
  });
});

describe("topForFraction", () => {
  it("is the inverse of scrollFraction", () => {
    for (const fraction of [0, 0.25, 0.5, 1]) {
      const top = topForFraction(fraction, 1000, 200);
      expect(scrollFraction({ top, height: 1000, client: 200 })).toBeCloseTo(fraction);
    }
  });

  it("never returns a negative or overflowing offset", () => {
    expect(topForFraction(-1, 1000, 200)).toBe(0);
    expect(topForFraction(2, 1000, 200)).toBe(800);
    expect(topForFraction(0.5, 100, 200)).toBe(0);
  });
});
