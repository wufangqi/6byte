import { describe, expect, it } from "vitest";
import { appShortcutBlocked } from "./shortcuts";

describe("tsx tests are collected", () => {
  it("sees a dialog as blocked", () => {
    expect(appShortcutBlocked(null, true)).toBe(true);
  });
});
