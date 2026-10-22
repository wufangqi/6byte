import { describe, expect, it } from "vitest";
import { windowOwnsSession } from "./sessionOwner";

describe("windowOwnsSession", () => {
  it("keeps the reopen list on the main window and the browser preview", () => {
    expect(windowOwnsSession("main")).toBe(true);
    expect(windowOwnsSession(null)).toBe(true);
    expect(windowOwnsSession(undefined)).toBe(true);
    expect(windowOwnsSession("")).toBe(true);
  });

  it("starts every extra window empty", () => {
    expect(windowOwnsSession("editor-1")).toBe(false);
    expect(windowOwnsSession("editor-1720000000000")).toBe(false);
  });
});
