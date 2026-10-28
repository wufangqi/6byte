// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";
import { sourceRangeForPreviewSelection } from "./previewSelection";

function mount(doc: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdown(doc, { sourceLines: true });
  document.body.replaceChildren(root);
  return root;
}

/** Range over `text` inside the first element matching `selector`. */
function rangeIn(root: HTMLElement, selector: string, text?: string, endSelector?: string): Range {
  const range = document.createRange();
  const start = root.querySelector(selector)!;
  const end = root.querySelector(endSelector ?? selector)!;
  if (text === undefined) {
    range.setStart(start, 0);
    range.setEnd(end, end.childNodes.length);
    return range;
  }
  const node = start.firstChild as Text;
  const at = node.data.indexOf(text);
  range.setStart(node, at);
  range.setEnd(node, at + text.length);
  return range;
}

const slice = (doc: string, range: { from: number; to: number } | null) =>
  range ? doc.slice(range.from, range.to) : null;

describe("preview selection to source", () => {
  it("tags blocks only when asked", () => {
    expect(renderMarkdown("# Title\n\nText")).not.toContain("data-src");
    expect(renderMarkdown("# Title\n\nText", { sourceLines: true })).toContain('data-src="2:3"');
  });

  it("narrows to plain text that appears once in the block", () => {
    const doc = "# Install\n\nOpen md, txt and log files here.\n";
    const root = mount(doc);
    const range = rangeIn(root, "p", "txt and log");
    expect(slice(doc, sourceRangeForPreviewSelection(root, range, doc))).toBe("txt and log");
  });

  it("takes the whole block when formatting hides the source text", () => {
    const doc = "Intro\n\nKeep **this** short.\n";
    const root = mount(doc);
    const range = rangeIn(root, "p:nth-of-type(2)");
    expect(slice(doc, sourceRangeForPreviewSelection(root, range, doc))).toBe(
      "Keep **this** short."
    );
  });

  it("spans several blocks without the trailing newline", () => {
    const doc = "# Title\n\nFirst *line*.\n\n- one\n- two\n\nAfter\n";
    const root = mount(doc);
    const range = rangeIn(root, "p", undefined, "li:last-child");
    expect(slice(doc, sourceRangeForPreviewSelection(root, range, doc))).toBe(
      "First *line*.\n\n- one\n- two"
    );
  });

  it("maps a heading to its text", () => {
    const doc = "# Install guide\n\nBody\n";
    const root = mount(doc);
    const range = rangeIn(root, "h1", "Install guide");
    expect(slice(doc, sourceRangeForPreviewSelection(root, range, doc))).toBe("Install guide");
  });

  it("ignores a collapsed range", () => {
    const doc = "Text\n";
    const root = mount(doc);
    const range = rangeIn(root, "p", "Text");
    range.collapse(true);
    expect(sourceRangeForPreviewSelection(root, range, doc)).toBeNull();
  });
});
