import { describe, expect, it } from "vitest";
import { parseNewFileFormat } from "./newFileFormat";

describe("parseNewFileFormat", () => {
  it("defaults to plain text", () => {
    expect(parseNewFileFormat(null)).toBe("txt");
    expect(parseNewFileFormat(undefined)).toBe("txt");
    expect(parseNewFileFormat("")).toBe("txt");
    expect(parseNewFileFormat("log")).toBe("txt");
  });

  it("keeps markdown when that format was saved", () => {
    expect(parseNewFileFormat("md")).toBe("md");
  });
});
