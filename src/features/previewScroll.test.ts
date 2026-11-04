// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { dropPreviewScrollExcept, notePreviewScroll, previewScrollTop } from "./previewScroll";

function scroller(clientHeight: number, scrollTop: number, connected = true): HTMLElement {
  const el = document.createElement("div");
  if (connected) document.body.append(el);
  Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    writable: true,
    value: scrollTop,
  });
  return el;
}

describe("preview tab scroll", () => {
  beforeEach(() => {
    dropPreviewScrollExcept(new Set());
    document.body.replaceChildren();
  });

  it("remembers a laid-out preview and ignores a hidden one", () => {
    notePreviewScroll("a", scroller(400, 240));
    expect(previewScrollTop("a")).toBe(240);

    notePreviewScroll("a", scroller(0, 0));
    expect(previewScrollTop("a")).toBe(240);

    const detached = scroller(400, 10, false);
    notePreviewScroll("a", detached);
    expect(previewScrollTop("a")).toBe(240);
  });

  it("forgets closed tabs", () => {
    notePreviewScroll("a", scroller(400, 20));
    notePreviewScroll("b", scroller(400, 30));
    dropPreviewScrollExcept(new Set(["b"]));
    expect(previewScrollTop("a")).toBe(0);
    expect(previewScrollTop("b")).toBe(30);
  });
});
