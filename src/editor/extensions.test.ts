// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { buildExtensions } from "./extensions";

function wrapping(filename: string): boolean {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "hello",
      extensions: buildExtensions(filename, () => {}),
    }),
  });
  const wrapped = view.contentDOM.classList.contains("cm-lineWrapping");
  view.destroy();
  parent.remove();
  return wrapped;
}

describe("transactions while the editor is off screen", () => {
  it("drops selection and document changes until the editor is on screen again", () => {
    const hidden = EditorState.create({
      doc: "hello",
      selection: { anchor: 4 },
      extensions: buildExtensions("a.txt", () => {}, { editorLive: () => false }),
    });
    const collapsed = hidden.update({ selection: { anchor: 0 } }).state;
    expect(collapsed.selection.main.head).toBe(4);
    expect(collapsed.doc.toString()).toBe("hello");

    const edited = hidden.update({ changes: { from: 0, to: 5, insert: "viewport only" } }).state;
    expect(edited.doc.toString()).toBe("hello");

    const shown = EditorState.create({
      doc: "hello",
      selection: { anchor: 4 },
      extensions: buildExtensions("a.txt", () => {}, { editorLive: () => true }),
    });
    expect(shown.update({ selection: { anchor: 1 } }).state.selection.main.head).toBe(1);
    expect(shown.update({ changes: { from: 0, insert: "X" } }).state.doc.toString()).toBe("Xhello");
  });
});

describe("plain text wrapping", () => {
  it("wraps .txt and untitled notes, and leaves markdown and logs on one line", () => {
    expect(wrapping("小说.txt")).toBe(true);
    expect(wrapping("未命名 1")).toBe(true);
    expect(wrapping("note.md")).toBe(false);
    expect(wrapping("app.log")).toBe(false);
    expect(wrapping("data.json")).toBe(false);
  });
});
