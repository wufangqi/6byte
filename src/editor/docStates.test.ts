import { describe, expect, it, beforeEach } from "vitest";
import { undoDepth } from "@codemirror/commands";
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
