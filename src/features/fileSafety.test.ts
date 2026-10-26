import { describe, expect, it } from "vitest";
import { duplicateTab, isWatcherEcho, statConflicts } from "./fileSafety";

describe("file safety", () => {
  it("finds a tab that already owns the save path", () => {
    const tabs = [
      { id: "a", path: "C:/docs/a.txt" },
      { id: "b", path: "C:/docs/b.txt" },
    ];
    expect(duplicateTab(tabs, "a", "c:\\docs\\b.txt")?.id).toBe("b");
    expect(duplicateTab(tabs, "b", "C:/docs/b.txt")).toBeNull();
  });

  it("treats a changed mtime or size as a conflict, and ignores our own save echo", () => {
    expect(statConflicts({ mtimeMs: 1, size: 2 }, { mtimeMs: 1, size: 2 })).toBe(false);
    expect(statConflicts({ mtimeMs: 1, size: 2 }, { mtimeMs: 3, size: 2 })).toBe(true);
    expect(isWatcherEcho({ mode: "text", mtimeMs: 5, size: 8 }, { mtimeMs: 5, size: 8 })).toBe(
      true
    );
    expect(isWatcherEcho({ mode: "large", mtimeMs: 5, size: 0 }, { mtimeMs: 5, size: 99 })).toBe(
      true
    );
    expect(isWatcherEcho({ mode: "text", mtimeMs: 5, size: 8 }, { mtimeMs: 5, size: 9 })).toBe(
      false
    );
  });
});
