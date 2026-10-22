import { beforeEach, describe, expect, it } from "vitest";
import type { OpenedFile } from "../ipc/types";
import { countLines, selectActiveTab, tabFromFile, tabFromLarge, useWorkspace } from "./workspace";

const makeFile = (path: string, content = "a\nb"): OpenedFile => ({
  path,
  name: path.split("/").pop() ?? path,
  content,
  meta: { charset: "UTF-8", bom: false, eol: "lf", lossy: false, mixedEol: false },
  size: content.length,
  mtimeMs: 1_700_000_000_000,
});

beforeEach(() => {
  useWorkspace.setState({ tabs: [], activeId: null, dragging: false, error: null, recent: [] });
});

describe("countLines", () => {
  it("counts an empty document as one line", () => {
    expect(countLines("")).toBe(1);
  });

  it("counts newline separated lines", () => {
    expect(countLines("a\nb\nc")).toBe(3);
  });
});

describe("addTab", () => {
  it("activates the new tab and records the recent file", () => {
    const tab = tabFromFile(makeFile("D:/tmp/a.md", "hello"));
    useWorkspace.getState().addTab(tab);

    const state = useWorkspace.getState();
    expect(state.activeId).toBe(tab.id);
    expect(selectActiveTab(state)?.name).toBe("a.md");
    expect(state.recent).toEqual(["D:/tmp/a.md"]);
  });

  it("reuses the existing tab for the same path", () => {
    const first = tabFromFile(makeFile("D:/tmp/a.md"));
    useWorkspace.getState().addTab(first);
    useWorkspace.getState().addTab(tabFromFile(makeFile("D:/tmp/a.md")));

    const state = useWorkspace.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeId).toBe(first.id);
  });
});

describe("markEdited", () => {
  it("sets dirty without copying the buffer and stores O(1) stats", () => {
    const tab = tabFromFile(makeFile("D:/tmp/a.md", "hello"));
    useWorkspace.getState().addTab(tab);

    useWorkspace.getState().markEdited(tab.id, { lines: 7, chars: 42 });

    const updated = selectActiveTab(useWorkspace.getState());
    expect(updated?.content).toBe("hello");
    expect(updated?.dirty).toBe(true);
    expect(updated?.lines).toBe(7);
    expect(updated?.chars).toBe(42);
  });
});

describe("markSaved", () => {
  it("clears dirty and renames the tab after a save-as", () => {
    const tab = tabFromFile(makeFile("D:/tmp/a.md", "hello"));
    useWorkspace.getState().addTab(tab);
    useWorkspace.getState().markEdited(tab.id, { lines: 1, chars: 5 });

    useWorkspace.getState().markSaved(tab.id, {
      path: "D:/tmp/renamed.md",
      content: "hello world",
      meta: { charset: "UTF-8", bom: false, eol: "lf", lossy: false, mixedEol: false },
      size: 11,
      mtimeMs: 1_700_000_000_999,
    });

    const saved = selectActiveTab(useWorkspace.getState());
    expect(saved?.name).toBe("renamed.md");
    expect(saved?.path).toBe("D:/tmp/renamed.md");
    expect(saved?.dirty).toBe(false);
    expect(saved?.content).toBe("hello world");
  });
});

describe("reloadTab", () => {
  it("replaces the buffer, clears dirty and bumps the version", () => {
    const tab = tabFromFile(makeFile("D:/tmp/a.md", "old"));
    useWorkspace.getState().addTab(tab);
    useWorkspace.getState().markEdited(tab.id, { lines: 1, chars: 3 });

    useWorkspace.getState().reloadTab(tab.id, makeFile("D:/tmp/a.md", "new\ncontent"));

    const reloaded = selectActiveTab(useWorkspace.getState());
    expect(reloaded?.content).toBe("new\ncontent");
    expect(reloaded?.dirty).toBe(false);
    expect(reloaded?.version).toBe(1);
    expect(reloaded?.lines).toBe(2);
  });
});

describe("setContent", () => {
  it("keeps a stale editor flush from overwriting a reloaded buffer", () => {
    const tab = tabFromFile(makeFile("D:/tmp/a.md", "saved"));
    useWorkspace.getState().addTab(tab);
    useWorkspace.getState().reloadTab(tab.id, makeFile("D:/tmp/a.md", "from disk"));

    // Simulate the unmount flush of the *old* editor (version 0).
    useWorkspace.getState().setContent(tab.id, "stale buffer", 0);
    expect(selectActiveTab(useWorkspace.getState())?.content).toBe("from disk");

    useWorkspace.getState().setContent(tab.id, "fresh buffer", 1);
    expect(selectActiveTab(useWorkspace.getState())?.content).toBe("fresh buffer");
  });
});

describe("tabFromLarge", () => {
  it("keeps only a descriptor for read-only viewer tabs", () => {
    const tab = tabFromLarge({
      path: "D:/logs/huge.log",
      name: "huge.log",
      size: 50 * 1024 * 1024,
      mtimeMs: 1_700_000_000_000,
      meta: { charset: "UTF-8", bom: false, eol: "lf", lossy: false, mixedEol: false },
      lineCount: 1_234_567,
    });

    expect(tab.mode).toBe("large");
    expect(tab.content).toBe("");
    expect(tab.lines).toBe(1_234_567);
    expect(tab.chars).toBe(0);
    expect(tab.dirty).toBe(false);
  });
});

describe("reloadLargeTab", () => {
  it("updates the descriptor, bumps the version and clears dirty", () => {
    const info = {
      path: "D:/logs/huge.log",
      name: "huge.log",
      size: 50 * 1024 * 1024,
      mtimeMs: 1_700_000_000_000,
      meta: { charset: "UTF-8", bom: false, eol: "lf", lossy: false, mixedEol: false },
      lineCount: 1_234_567,
    } as const;
    const tab = tabFromLarge({ ...info, meta: { ...info.meta } });
    useWorkspace.getState().addTab(tab);

    useWorkspace.getState().reloadLargeTab(tab.id, {
      ...info,
      size: 55 * 1024 * 1024,
      mtimeMs: 1_700_000_001_000,
      lineCount: 1_300_000,
    });

    const reloaded = selectActiveTab(useWorkspace.getState());
    expect(reloaded?.version).toBe(1);
    expect(reloaded?.lines).toBe(1_300_000);
    expect(reloaded?.size).toBe(55 * 1024 * 1024);
    expect(reloaded?.dirty).toBe(false);
  });
});

describe("removeRecent", () => {
  it("drops a single entry and keeps the order", () => {
    useWorkspace.getState().setRecent(["D:/a.md", "D:/b.md", "D:/c.md"]);
    useWorkspace.getState().removeRecent("D:/b.md");
    expect(useWorkspace.getState().recent).toEqual(["D:/a.md", "D:/c.md"]);
  });

  it("ignores paths that are not in the list", () => {
    useWorkspace.getState().setRecent(["D:/a.md"]);
    useWorkspace.getState().removeRecent("D:/missing.md");
    expect(useWorkspace.getState().recent).toEqual(["D:/a.md"]);
  });

  it("clears the list when the last entry is removed", () => {
    useWorkspace.getState().setRecent(["D:/a.md"]);
    useWorkspace.getState().removeRecent("D:/a.md");
    expect(useWorkspace.getState().recent).toEqual([]);
  });
});

describe("closeTab", () => {
  it("activates the neighbouring tab when the active one closes", () => {
    const first = tabFromFile(makeFile("D:/tmp/a.md"));
    const second = tabFromFile(makeFile("D:/tmp/b.md"));
    useWorkspace.getState().addTab(first);
    useWorkspace.getState().addTab(second);
    useWorkspace.getState().setActive(first.id);

    useWorkspace.getState().closeTab(first.id);

    const state = useWorkspace.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeId).toBe(second.id);
  });

  it("clears the selection when the last tab closes", () => {
    const tab = tabFromFile(makeFile("D:/tmp/a.md"));
    useWorkspace.getState().addTab(tab);
    useWorkspace.getState().closeTab(tab.id);

    expect(useWorkspace.getState().activeId).toBeNull();
  });
});
