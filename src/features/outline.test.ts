import { describe, expect, it } from "vitest";
import { extractHeadings } from "./outline";

describe("extractHeadings", () => {
  it("returns level, text, slug and 1-based line", () => {
    const items = extractHeadings("# One\n\ntext\n\n## Two\n");
    expect(items).toEqual([
      { level: 1, text: "One", slug: "one", line: 1 },
      { level: 2, text: "Two", slug: "two", line: 5 },
    ]);
  });

  it("skips headings inside fenced code blocks", () => {
    const source = "# Real\n\n```bash\n# not a heading\necho hi\n```\n\n## Also real\n";
    expect(extractHeadings(source).map((item) => item.text)).toEqual(["Real", "Also real"]);
  });

  it("strips inline markdown from labels and slugs consistently", () => {
    const items = extractHeadings("## **Bold** `code` [link](https://example.com)\n");
    expect(items[0].text).toBe("Bold code link");
    expect(items[0].slug).toBe("bold-code-link");
  });

  it("dedupes repeated headings like the renderer", () => {
    const items = extractHeadings("# Intro\n\n# Intro\n\n# Intro\n");
    expect(items.map((item) => item.slug)).toEqual(["intro", "intro-1", "intro-2"]);
  });

  it("handles empty sources and non-heading lines", () => {
    expect(extractHeadings("")).toEqual([]);
    expect(extractHeadings("just text\nno headings here\n")).toEqual([]);
  });
});
