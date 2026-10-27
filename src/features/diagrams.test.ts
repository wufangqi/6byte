import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";
import { renderKatexHtml, renderMermaidSvg, texSource } from "./diagrams";

/** Mermaid measures SVG in the DOM. Node has none, so the diagram cases borrow jsdom. */
function installDom(): void {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const view = dom.window;
  (view.SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
    ({
      x: 0,
      y: 0,
      width: 40,
      height: 16,
      top: 0,
      left: 0,
      right: 40,
      bottom: 16,
    }) as DOMRect;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = view;
  globals.document = view.document;
  globals.DOMParser = view.DOMParser;
  globals.HTMLElement = view.HTMLElement;
  globals.SVGElement = view.SVGElement;
  globals.SVGSVGElement = view.SVGSVGElement;
  globals.Element = view.Element;
  globals.Node = view.Node;
  globals.CSSStyleSheet = view.CSSStyleSheet;
  globals.XMLSerializer = view.XMLSerializer;
  globals.MutationObserver = view.MutationObserver;
  globals.getComputedStyle = view.getComputedStyle.bind(view);
}

describe("texSource", () => {
  it("strips inline and display delimiters", () => {
    expect(texSource("$E=mc^2$", false)).toBe("E=mc^2");
    expect(texSource("$$\na < b\n$$", true)).toBe("a < b");
  });
});

describe("renderKatexHtml", () => {
  it("renders inline and display formulas", async () => {
    const inline = await renderKatexHtml("$E=mc^2$", false);
    const block = await renderKatexHtml("$$a^2+b^2$$", true);
    expect(inline).toContain("katex");
    expect(inline).not.toContain("katex-display");
    expect(block).toContain("katex-display");
  });

  it("returns null for a formula KaTeX cannot parse", async () => {
    expect(await renderKatexHtml("$\\notacommand$", false)).toBeNull();
  });

  it("does not let the formula inject markup", async () => {
    const html = await renderKatexHtml("$<script>alert(1)</script>$", false);
    expect(html ?? "").not.toContain("<script>");
  });
});

describe("renderMermaidSvg", () => {
  beforeAll(installDom);

  it("renders a flowchart to svg", async () => {
    const svg = await renderMermaidSvg("graph TD\n  A-->B");
    expect(svg).toContain("<svg");
    expect(svg).not.toContain("<script");
  }, 120000);

  it("returns null for a diagram that cannot be parsed", async () => {
    expect(await renderMermaidSvg("this is not a diagram")).toBeNull();
  }, 20000);
});
