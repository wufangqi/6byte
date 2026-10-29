import { describe, expect, it } from "vitest";
import { parseDocument, sectionByTitle, sectionCovering } from "./documentModel";
import { extractHeadings } from "./outline";

const SAMPLE = `---
title: Note
---

# Guide

Intro line
still the intro.

## Setup

See [the guide](./guide.md) and ![diagram](assets/diagram.png).

\`\`\`ts
# not a heading
const value = 1;
\`\`\`

## Run

Done.
`;

describe("document model", () => {
  const model = parseDocument(SAMPLE);

  it("matches the outline heading list", () => {
    expect(model.headings).toEqual(extractHeadings(SAMPLE));
    expect(model.headings.map((heading) => heading.text)).toEqual(["Guide", "Setup", "Run"]);
  });

  it("keeps a closed frontmatter block out of the headings", () => {
    expect(model.frontmatter).toBe("title: Note");
    expect(model.blocks[0]).toMatchObject({ kind: "frontmatter", startLine: 1, endLine: 3 });
    expect(model.headings.some((heading) => heading.text === "title: Note")).toBe(false);
  });

  it("records code and paragraph bounds and ignores headings in fences", () => {
    const code = model.blocks.find((block) => block.kind === "code");
    expect(code).toMatchObject({ language: "ts", startLine: 14, endLine: 17 });
    expect(code?.text).toContain("# not a heading");
    const intro = model.blocks.find(
      (block) => block.kind === "paragraph" && block.text.startsWith("Intro")
    );
    expect(intro).toMatchObject({ startLine: 7, endLine: 8 });
  });

  it("collects links and local image resources, not links inside code", () => {
    expect(model.links.map((link) => link.href)).toEqual(["./guide.md", "assets/diagram.png"]);
    expect(model.resources.map((link) => link.href)).toEqual(["assets/diagram.png"]);
  });

  it("ends a section at the next heading of the same or higher level", () => {
    const setup = sectionByTitle(model, "Setup");
    expect(setup?.line).toBe(10);
    expect(setup?.endLine).toBe(18);
    expect(sectionCovering(model, 12)?.text).toBe("Setup");
    expect(sectionCovering(model, 8)?.text).toBe("Guide");
    expect(sectionByTitle(model, "Guide")?.children.map((child) => child.text)).toEqual([
      "Setup",
      "Run",
    ]);
  });

  it("leaves an unclosed frontmatter rule as ordinary text", () => {
    const open = parseDocument("---\n# Real\n");
    expect(open.frontmatter).toBeNull();
    expect(open.headings.map((heading) => heading.text)).toEqual(["Real"]);
  });
});
