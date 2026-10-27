import { describe, expect, it } from "vitest";
import { extensionOf, fileNameProblem, withExtension } from "./fileName";

describe("fileNameProblem", () => {
  it("accepts a normal Markdown file name", () => {
    expect(fileNameProblem("周报 2026.md")).toBeNull();
    expect(fileNameProblem("  notes.txt ")).toBeNull();
  });

  it("rejects empty names, dot names and path separators", () => {
    expect(fileNameProblem("   ")).toBe("empty");
    expect(fileNameProblem(".")).toBe("dot");
    expect(fileNameProblem("..")).toBe("dot");
    expect(fileNameProblem("sub/name.md")).toBe("separator");
    expect(fileNameProblem("sub\\name.md")).toBe("separator");
    expect(fileNameProblem("bad:name.md")).toBe("separator");
  });

  it("rejects names that are too long", () => {
    expect(fileNameProblem("a".repeat(256))).toBe("tooLong");
  });
});

describe("withExtension", () => {
  it("keeps an explicit extension", () => {
    expect(withExtension("notes.txt", ".md")).toBe("notes.txt");
  });

  it("adds the previous extension when only a base name was typed", () => {
    expect(withExtension("新笔记", ".md")).toBe("新笔记.md");
    expect(withExtension("新笔记", ".txt")).toBe("新笔记.txt");
  });
});

describe("extensionOf", () => {
  it("returns the trailing extension", () => {
    expect(extensionOf("a.md")).toBe(".md");
    expect(extensionOf("a.b.txt")).toBe(".txt");
    expect(extensionOf("README")).toBe("");
  });
});
