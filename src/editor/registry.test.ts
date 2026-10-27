// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { dropDocStatesExcept, ensureDocState } from "./docStates";
import {
  attachView,
  detachView,
  insertTextAtSelection,
  readBuffer,
  revealLineWhenReady,
  settleEditor,
} from "./registry";

beforeEach(() => {
  dropDocStatesExcept(new Set());
});

describe("readBuffer", () => {
  it("uses the editor state, then the open snapshot", () => {
    ensureDocState("a", {
      content: "live",
      filename: "a.txt",
      version: 0,
      onStats: () => {},
    });
    expect(readBuffer("a", "snapshot")).toBe("live");
    expect(readBuffer("missing", "snapshot")).toBe("snapshot");
  });
});

describe("revealLineWhenReady", () => {
  it("reveals immediately when this window is already showing the tab", () => {
    const parent = document.createElement("div");
    const view = new EditorView({
      state: EditorState.create({ doc: "one\ntwo" }),
      parent,
    });
    attachView("shown", view);
    let shown = false;
    revealLineWhenReady("shown", 2, () => {
      shown = true;
    });
    expect(shown).toBe(true);
    expect(view.state.selection.main.from).toBe(view.state.doc.line(2).from);
    detachView(view);
    view.destroy();
  });

  it("waits for the view to show the tab, then reveals once", () => {
    const parent = document.createElement("div");
    const view = new EditorView({
      state: EditorState.create({ doc: "one\ntwo" }),
      parent,
    });
    let shown = 0;
    const stop = revealLineWhenReady("later", 2, () => {
      shown += 1;
    });
    expect(shown).toBe(0);
    attachView("later", view);
    expect(shown).toBe(0);
    settleEditor("later");
    expect(shown).toBe(1);
    settleEditor("later");
    expect(shown).toBe(1);
    stop();
    detachView(view);
    view.destroy();
  });
});

describe("insertTextAtSelection", () => {
  it("replaces the visible tab selection and moves the caret after the inserted answer", () => {
    const parent = document.createElement("div");
    const view = new EditorView({
      state: EditorState.create({
        doc: "before selection after",
        selection: { anchor: 7, head: 16 },
      }),
      parent,
    });
    attachView("answer", view);

    expect(insertTextAtSelection("answer", "answer")).toBe(true);
    expect(view.state.doc.toString()).toBe("before answer after");
    expect(view.state.selection.main.from).toBe(13);
    expect(insertTextAtSelection("other", "nope")).toBe(false);

    detachView(view);
    view.destroy();
  });
});
