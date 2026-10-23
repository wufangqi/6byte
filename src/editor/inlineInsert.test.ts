// @vitest-environment jsdom
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { acceptInline, cancelInline, inlineInsertField, paintInline } from "./inlineInsert";

function editor(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [history(), inlineInsertField],
    }),
  });
}

describe("inline insert", () => {
  it("highlights streamed text, then accept replaces the original without an extra undo step", () => {
    const view = editor("前文原文后文");
    const end = paintInline(view, 4, 4, "新");
    expect(end).toBe(5);
    expect(view.state.doc.toString()).toBe("前文原文新后文");
    expect(view.dom.querySelector(".cm-ai-inserted")?.textContent).toBe("新");

    expect(acceptInline(view, 2, 4, 4, 5)).toBe(true);
    expect(view.state.doc.toString()).toBe("前文新后文");
    expect(view.dom.querySelector(".cm-ai-inserted")).toBeNull();
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("前文原文后文");
    view.destroy();
  });

  it("cancel deletes only the insert", () => {
    const view = editor("原文");
    paintInline(view, 2, 2, "补充");
    cancelInline(view, 2, 4);
    expect(view.state.doc.toString()).toBe("原文");
    expect(undo(view)).toBe(false);
    view.destroy();
  });
});
