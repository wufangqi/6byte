// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { undoDepth } from "@codemirror/commands";
import { language } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import {
  docStateCount,
  dropDocStatesExcept,
  ensureDocState,
  getDocScrollTop,
  getDocText,
  reconfigureDocStates,
  saveDocState,
  type DocStateInit,
} from "./docStates";

const init = (content: string, version = 0, filename = "note.md"): DocStateInit => ({
  content,
  filename,
  version,
  onStats: () => {},
});

beforeEach(() => {
  dropDocStatesExcept(new Set());
});

describe("per-tab editor states (M-06)", () => {
  it("reuses the cached state while the store version is unchanged", () => {
    const first = ensureDocState("a", init("hello"));
    const second = ensureDocState("a", init("hello"));
    expect(second).toBe(first);
    expect(docStateCount()).toBe(1);
  });

  it("keeps undo history when a state is stored back and reused", () => {
    const first = ensureDocState("a", init("hello"));
    const edited = first.update({ changes: { from: 5, insert: " world" } }).state;
    saveDocState("a", edited);

    expect(getDocText("a")).toBe("hello world");
    expect(undoDepth(edited)).toBe(1);
    // Simulates switching away and back: the same state (and history) comes back.
    expect(ensureDocState("a", init("hello"))).toBe(edited);
  });

  it("rebuilds the state (and drops history) when the buffer is reloaded", () => {
    const first = ensureDocState("a", init("hello"));
    const edited = first.update({ changes: { from: 0, insert: "x" } }).state;
    saveDocState("a", edited);

    const reloaded = ensureDocState("a", init("fresh", 1));
    expect(getDocText("a")).toBe("fresh");
    expect(undoDepth(reloaded)).toBe(0);
    expect(reloaded).not.toBe(edited);
  });

  it("keeps tabs independent and forgets closed ones", () => {
    ensureDocState("a", init("alpha"));
    ensureDocState("b", init("beta"));
    expect(docStateCount()).toBe(2);

    dropDocStatesExcept(new Set(["a"]));
    expect(docStateCount()).toBe(1);
    expect(getDocText("a")).toBe("alpha");
    expect(getDocText("b")).toBeNull();
  });

  it("reconfigures highlighting and wrapping when the filename changes", () => {
    const first = ensureDocState("a", init("hello", 0, "note.txt"));
    const edited = first.update({ changes: { from: 5, insert: "!" } }).state;
    saveDocState("a", edited);

    const renamed = ensureDocState("a", init("hello", 0, "note.md"));
    expect(getDocText("a")).toBe("hello!");
    expect(undoDepth(renamed)).toBe(1);
    expect(renamed.facet(language)?.name).toBe("markdown");

    const parent = document.createElement("div");
    document.body.append(parent);
    const before = new EditorView({ state: first, parent });
    expect(before.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);
    before.destroy();
    const after = new EditorView({ state: renamed, parent });
    expect(after.contentDOM.classList.contains("cm-lineWrapping")).toBe(false);
    after.destroy();
    parent.remove();
  });

  it("remembers the scroll offset per tab", () => {
    const state = ensureDocState("a", init("hello"));
    expect(getDocScrollTop("a")).toBe(0);
    saveDocState("a", state, 120);
    expect(getDocScrollTop("a")).toBe(120);
  });

  it("reconfigures inactive states for theme / language without losing text", () => {
    ensureDocState("a", init("alpha"));
    ensureDocState("b", init("beta"));
    expect(() => reconfigureDocStates("a")).not.toThrow();
    expect(getDocText("b")).toBe("beta");
  });
});
