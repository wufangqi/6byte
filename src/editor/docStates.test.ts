// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { undoDepth } from "@codemirror/commands";
import { language } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  docStateCount,
  dropDocStatesExcept,
  ensureDocState,
  getDocScrollAnchor,
  getDocScrollTop,
  getDocText,
  readScrollTop,
  reconfigureDocStates,
  saveDocState,
  selectionJumpedHome,
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
    saveDocState("a", state, 120, 40);
    expect(getDocScrollTop("a")).toBe(120);
    expect(getDocScrollAnchor("a")).toBe(40);
  });

  it("keeps a remembered scroll when the scroller is detached or hidden", () => {
    const laidOut = document.createElement("div");
    document.body.append(laidOut);
    Object.defineProperty(laidOut, "clientHeight", { value: 400 });
    laidOut.scrollTop = 180;
    expect(readScrollTop(laidOut, 10)).toBe(180);

    const hidden = document.createElement("div");
    document.body.append(hidden);
    Object.defineProperty(hidden, "clientHeight", { value: 0 });
    hidden.scrollTop = 0;
    expect(readScrollTop(hidden, 180)).toBe(180);

    const detached = document.createElement("div");
    Object.defineProperty(detached, "clientHeight", { value: 400 });
    detached.scrollTop = 0;
    expect(readScrollTop(detached, 180)).toBe(180);
    laidOut.remove();
    hidden.remove();
  });

  it("detects a caret that the browser collapsed to the start", () => {
    const left = EditorSelection.single(40);
    expect(selectionJumpedHome(EditorSelection.single(0), left)).toBe(true);
    expect(selectionJumpedHome(left, left)).toBe(false);
    expect(selectionJumpedHome(EditorSelection.single(0), EditorSelection.single(0))).toBe(false);
    expect(selectionJumpedHome(EditorSelection.single(12), left)).toBe(false);
  });

  it("reconfigures inactive states for theme / language without losing text", () => {
    ensureDocState("a", init("alpha"));
    ensureDocState("b", init("beta"));
    expect(() => reconfigureDocStates("a")).not.toThrow();
    expect(getDocText("b")).toBe("beta");
  });
});
