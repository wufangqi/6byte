import { describe, expect, it } from "vitest";
import { fileName, samePath } from "./paths";

describe("samePath", () => {
  it("matches identical paths", () => {
    expect(samePath("D:/docs/a.md", "D:/docs/a.md")).toBe(true);
  });

  it("ignores separator style and casing on Windows paths", () => {
    expect(samePath("D:\\docs\\a.md", "d:/docs/A.md")).toBe(true);
  });

  it("keeps POSIX paths case-sensitive", () => {
    expect(samePath("/docs/a.md", "/docs/A.md")).toBe(false);
    expect(samePath("/docs/a.md", "/docs/b.md")).toBe(false);
  });
});

describe("fileName", () => {
  it("returns the last segment for Windows and POSIX paths", () => {
    expect(fileName("D:\\docs\\笔记.md")).toBe("笔记.md");
    expect(fileName("/home/user/notes/todo.txt")).toBe("todo.txt");
  });

  it("keeps bare names and falls back to the input", () => {
    expect(fileName("README.md")).toBe("README.md");
    expect(fileName("D:\\docs\\")).toBe("docs");
  });
});
