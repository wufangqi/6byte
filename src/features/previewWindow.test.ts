import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";
import { previewSlice, WINDOW_CHARS } from "./previewWindow";

describe("preview window", () => {
  it("covers the anchor and stays within the character budget", () => {
    const source = Array.from(
      { length: 80 },
      (_, index) => `## Section ${index}\n\nParagraph ${index}.\n`
    ).join("\n");
    const slice = previewSlice(source, 40, 500);
    expect(slice.full).toBe(false);
    expect(slice.text.length).toBeLessThanOrEqual(500);
    expect(slice.startLine).toBeLessThanOrEqual(40);
    expect(slice.endLine).toBeGreaterThan(40);
    expect(source.split("\n")[40]).toBe(slice.text.split("\n")[40 - slice.startLine]);
  });

  it("does not cut a fenced block that is longer than the window", () => {
    const fence = [
      "```ts",
      ...Array.from({ length: 40 }, () => "const value = 1;"),
      "```",
      "",
      "After the fence.",
    ].join("\n");
    const slice = previewSlice(fence, 0, 80);
    expect(slice.text).toContain("const value = 1;");
    expect(slice.text).toContain("```");
    expect(slice.text).not.toContain("After the fence.");
    expect(slice.endLine).toBeLessThan(slice.totalLines);
  });

  it("reports a short document as the whole file", () => {
    const source = "# Title\n\nOne paragraph.\n";
    const slice = previewSlice(source, 0, WINDOW_CHARS);
    expect(slice.full).toBe(true);
    expect(slice.text).toBe(source);
  });

  it("keeps data-src line numbers pointing at the whole document", () => {
    const source = Array.from(
      { length: 30 },
      (_, index) => `Paragraph ${index} stays here.\n`
    ).join("\n");
    const slice = previewSlice(source, 20, 200);
    const html = renderMarkdown(slice.text, { sourceLines: true, lineOffset: slice.startLine });
    const match = /data-src="(\d+):(\d+)"/.exec(html);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(slice.startLine);
    expect(Number(match?.[2])).toBeLessThanOrEqual(slice.endLine);
  });
});
