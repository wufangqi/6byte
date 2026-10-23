// @vitest-environment jsdom
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { acceptGhost, completionExtension, dismissGhost, previewGhost } from "./completion";

function editor(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [history(), completionExtension()],
    }),
  });
}

describe("ghost completion", () => {
  it("shows a suggestion, accepts it with one undo, and does not keep the ghost", () => {
    const view = editor("他走进了");
    previewGhost(view, "客栈");
    expect(view.dom.querySelector(".cm-ghost-text")?.textContent).toBe("客栈");
    expect(view.state.doc.toString()).toBe("他走进了");

    expect(acceptGhost(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("他走进了客栈");
    expect(view.dom.querySelector(".cm-ghost-text")).toBeNull();
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("他走进了");
    view.destroy();
  });

  it("shrinks when the typed text matches, and Escape drops the rest", () => {
    const view = editor("他说");
    previewGhost(view, "下一句");
    view.dispatch({
      changes: { from: view.state.selection.main.head, insert: "下" },
      selection: { anchor: view.state.selection.main.head + 1 },
    });
    expect(view.state.doc.toString()).toBe("他说下");
    expect(view.dom.querySelector(".cm-ghost-text")?.textContent).toBe("一句");

    expect(dismissGhost(view)).toBe(true);
    expect(view.dom.querySelector(".cm-ghost-text")).toBeNull();
    expect(view.state.doc.toString()).toBe("他说下");
    view.destroy();
  });
});
