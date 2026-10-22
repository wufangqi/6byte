import { describe, expect, it } from "vitest";
import { samePath } from "./paths";

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
