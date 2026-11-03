import { describe, expect, it } from "vitest";
import {
  duplicateTab,
  cancelOwnWrite,
  finishOwnWrite,
  isOwnWriteEvent,
  isWatcherEcho,
  saveTouchesDisk,
  statConflicts,
  beginOwnWrite,
} from "./fileSafety";

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

  it("does not write a clean file that is already on disk", () => {
    const clean = {
      path: "C:/docs/a.txt",
      dirty: false,
      meta: { lossy: false, mixedEol: false },
    };
    expect(saveTouchesDisk(clean, false)).toBe(false);
    expect(saveTouchesDisk({ ...clean, dirty: true }, false)).toBe(true);
    expect(saveTouchesDisk({ ...clean, path: null }, false)).toBe(true);
    expect(saveTouchesDisk(clean, true)).toBe(true);
    expect(saveTouchesDisk({ ...clean, meta: { lossy: true, mixedEol: false } }, false)).toBe(true);
  });

  it("treats a watcher event during our own save as an echo, before the stat is stored", () => {
    beginOwnWrite("C:/docs/a.txt");
    expect(isOwnWriteEvent("C:\\docs\\a.txt", { size: 4, mtimeMs: 9 })).toBe(true);
    finishOwnWrite("C:/docs/a.txt", { size: 4, mtimeMs: 9 });
    expect(isOwnWriteEvent("C:\\docs\\a.txt", { size: 4, mtimeMs: 9 })).toBe(true);
    expect(isOwnWriteEvent("C:/docs/a.txt", { size: 8, mtimeMs: 10 })).toBe(false);

    beginOwnWrite("C:/docs/a.txt");
    finishOwnWrite("C:/docs/a.txt", { size: 4, mtimeMs: 9 });
    expect(isOwnWriteEvent("C:\\docs\\a.txt", { size: 4, mtimeMs: 9 })).toBe(true);
    cancelOwnWrite("C:/docs/missing.txt");
  });
});
