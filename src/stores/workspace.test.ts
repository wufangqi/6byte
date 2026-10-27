import { beforeEach, describe, expect, it } from "vitest";
import type { OpenedFile } from "../ipc/types";
import {
  SETTINGS_TAB_ID,
  countLines,
  selectActiveTab,
  tabFromFile,
  tabFromLarge,
  useWorkspace,
} from "./workspace";

const makeFile = (path: string, content = "a\nb"): OpenedFile => ({
  path,
  name: path.split("/").pop() ?? path,
  content,
  meta: { charset: "UTF-8", bom: false, eol: "lf", lossy: false, mixedEol: false },
  size: content.length,
  mtimeMs: 1_700_000_000_000,
});

beforeEach(() => {
  useWorkspace.setState({
    tabs: [],
    activeId: null,
    settingsOpen: false,
    dragging: false,
    error: null,
    recent: [],
  });
});

describe("settings tab", () => {
  it("opens once, falls back to it when the last file closes, and hands focus back on close", () => {
    const store = useWorkspace.getState();
    store.addTab(tabFromFile(makeFile("/a.md")));
    const fileId = useWorkspace.getState().activeId as string;

    store.openSettings();
    store.openSettings();
    expect(useWorkspace.getState().activeId).toBe(SETTINGS_TAB_ID);
    expect(useWorkspace.getState().tabs).toHaveLength(1);
    expect(selectActiveTab(useWorkspace.getState())).toBeNull();

    store.setActive(fileId);
    store.closeTab(fileId);
    expect(useWorkspace.getState().activeId).toBe(SETTINGS_TAB_ID);

    store.addTab(tabFromFile(makeFile("/b.md")));
    store.setActive(SETTINGS_TAB_ID);
    store.closeSettings();
    expect(useWorkspace.getState().settingsOpen).toBe(false);
    expect(selectActiveTab(useWorkspace.getState())?.path).toBe("/b.md");
  });

  it("opens on the requested section and otherwise keeps the last one", () => {
    const store = useWorkspace.getState();
    store.openSettings("models");
    expect(useWorkspace.getState().settingsSection).toBe("models");
    store.setSettingsSection("usage");
    store.closeSettings();
    store.openSettings();
    expect(useWorkspace.getState().settingsSection).toBe("usage");
    store.openSettings("general");
    expect(useWorkspace.getState().settingsSection).toBe("general");
  });
});

describe("countLines", () => {
  it("counts an empty document as one line", () => {
    expect(countLines("")).toBe(1);
  });

  it("counts newline separated lines", () => {
    expect(countLines("a\nb\nc")).toBe(3);
  });
});

describe("newTab", () => {
  it("starts a Markdown document that is ready to edit and preview", () => {
    useWorkspace.getState().newTab();

    const tab = selectActiveTab(useWorkspace.getState());
    expect(tab?.name).toMatch(/\.md$/);
    expect(tab?.path).toBeNull();
    expect(tab?.preview).toBe(true);
    expect(tab?.source).toBe(true);
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

  it("noteDocStats updates the counts and leaves a clean tab clean", () => {
    const tab = tabFromFile(makeFile("D:/tmp/a.md", "hello"));
    useWorkspace.getState().addTab(tab);

    useWorkspace.getState().noteDocStats(tab.id, { lines: 3, chars: 9 });

    const updated = selectActiveTab(useWorkspace.getState());
    expect(updated?.dirty).toBe(false);
    expect(updated?.lines).toBe(3);
    expect(updated?.chars).toBe(9);
    expect(updated?.content).toBe("hello");
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

describe("renameTab", () => {
  it("moves the tab to the new path and keeps the buffer dirty", () => {
    const tab = tabFromFile(makeFile("D:/tmp/a.md", "hello"));
    useWorkspace.getState().addTab(tab);
    useWorkspace.getState().markEdited(tab.id, { lines: 1, chars: 5 });

    useWorkspace.getState().renameTab(tab.id, {
      path: "D:/tmp/draft.md",
      name: "draft.md",
      mtimeMs: 1_700_000_000_500,
    });

    const renamed = selectActiveTab(useWorkspace.getState());
    expect(renamed?.path).toBe("D:/tmp/draft.md");
    expect(renamed?.name).toBe("draft.md");
    expect(renamed?.dirty).toBe(true);
    expect(renamed?.content).toBe("hello");
    expect(useWorkspace.getState().recent[0]).toBe("D:/tmp/draft.md");
    expect(useWorkspace.getState().recent).not.toContain("D:/tmp/a.md");
  });

  it("turns off the preview when a Markdown file is renamed to plain text", () => {
    const tab = tabFromFile(makeFile("D:/tmp/a.md", "# Title"));
    useWorkspace.getState().addTab(tab);

    useWorkspace.getState().renameTab(tab.id, {
      path: "D:/tmp/a.txt",
      name: "a.txt",
      mtimeMs: 1,
    });

    expect(selectActiveTab(useWorkspace.getState())?.preview).toBe(false);
  });
});

describe("setName", () => {
  it("renames an unsaved buffer without touching its path", () => {
    useWorkspace.getState().newTab();
    const tab = selectActiveTab(useWorkspace.getState());
    expect(tab).not.toBeNull();

    useWorkspace.getState().setName(tab!.id, "笔记.md");

    const renamed = selectActiveTab(useWorkspace.getState());
    expect(renamed?.name).toBe("笔记.md");
    expect(renamed?.path).toBeNull();
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

describe("setPreview", () => {
  it("opens markdown in preview and keeps other files in the editor", () => {
    const markdown = tabFromFile(makeFile("D:/tmp/a.md"));
    const plain = tabFromFile(makeFile("D:/tmp/b.txt"));
    expect(markdown.preview).toBe(true);
    expect(markdown.source).toBe(false);
    expect(plain.preview).toBe(false);
    expect(plain.source).toBe(true);

    useWorkspace.getState().addTab(markdown);
    useWorkspace.getState().addTab(plain);
    useWorkspace.getState().setSource(markdown.id, true);
    useWorkspace.getState().setPreview(plain.id, true);

    const state = useWorkspace.getState();
    expect(state.tabs.find((tab) => tab.id === markdown.id)?.source).toBe(true);
    expect(state.tabs.find((tab) => tab.id === plain.id)?.preview).toBe(true);
    expect(state.tabs.find((tab) => tab.id === plain.id)?.source).toBe(true);
  });

  it("reopens a markdown file in preview, with the source hidden", () => {
    const opened = tabFromFile(makeFile("D:/tmp/a.md"));
    useWorkspace.getState().addTab(opened);
    useWorkspace.getState().setSource(opened.id, true);
    useWorkspace.getState().closeTab(opened.id);

    const again = tabFromFile(makeFile("D:/tmp/a.md"));
    useWorkspace.getState().addTab(again);
    const active = selectActiveTab(useWorkspace.getState());
    expect(active?.preview).toBe(true);
    expect(active?.source).toBe(false);
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
