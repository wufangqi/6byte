// @vitest-environment jsdom
import { history } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  commitRewrite,
  rewritePreviewField,
  showRewritePreview,
  undoRewrite,
} from "./rewritePreview";

describe("rewrite preview", () => {
  it("marks the original in the text, then one undo restores the write", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "你好世界",
        extensions: [history(), rewritePreviewField],
      }),
    });

    showRewritePreview(view, {
      from: 0,
      to: 2,
      text: "您好",
      originalLabel: "原文",
      rewriteLabel: "改写",
    });
    expect(view.state.doc.toString()).toBe("你好世界");
    expect(view.dom.querySelector(".cm-ai-original")).not.toBeNull();
    expect(view.dom.textContent).toContain("原文");
    expect(view.dom.textContent).toContain("您好");

    expect(commitRewrite(view, 0, 2, "您好")).toBe(true);
    expect(view.state.doc.toString()).toBe("您好世界");
    expect(view.dom.querySelector(".cm-ai-original")).toBeNull();

    expect(undoRewrite(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("你好世界");

    view.destroy();
    parent.remove();
  });

  it("exposes per-proposal decisions in the editor instead of the side panel", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onAccept = vi.fn();
    const onDiscard = vi.fn();
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "你好世界",
        extensions: [history(), rewritePreviewField],
      }),
    });

    showRewritePreview(view, {
      from: 0,
      to: 2,
      text: "您好",
      originalLabel: "原文",
      rewriteLabel: "改写",
      onAccept,
      onDiscard,
      acceptLabel: "接受此块",
      discardLabel: "保留原文",
    });

    const actions = view.dom.querySelectorAll<HTMLButtonElement>(".cm-ai-proposal__action");
    expect(actions).toHaveLength(2);
    actions[0].click();
    actions[1].click();
    expect(onAccept).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledOnce();

    view.destroy();
    parent.remove();
  });
});
