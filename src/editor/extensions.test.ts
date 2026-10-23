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

describe("plain text wrapping", () => {
  it("wraps .txt and untitled notes, and leaves markdown and logs on one line", () => {
    expect(wrapping("小说.txt")).toBe(true);
    expect(wrapping("未命名 1")).toBe(true);
    expect(wrapping("note.md")).toBe(false);
    expect(wrapping("app.log")).toBe(false);
    expect(wrapping("data.json")).toBe(false);
  });
});
