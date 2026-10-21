import { describe, expect, it } from "vitest";
import { highlightCode, normalizeLanguage } from "./highlight";

describe("normalizeLanguage", () => {
  it("maps common aliases to bundled languages", () => {
    expect(normalizeLanguage("js")).toBe("javascript");
    expect(normalizeLanguage("ts")).toBe("typescript");
    expect(normalizeLanguage("sh")).toBe("bash");
    expect(normalizeLanguage("yml")).toBe("yaml");
    expect(normalizeLanguage("RS")).toBe("rust");
  });

  it("keeps supported languages as-is", () => {
    expect(normalizeLanguage("python")).toBe("python");
    expect(normalizeLanguage(" json ")).toBe("json");
  });

  it("returns null for unsupported or empty languages", () => {
    expect(normalizeLanguage("brainfuck")).toBeNull();
    expect(normalizeLanguage("")).toBeNull();
    expect(normalizeLanguage(null)).toBeNull();
  });
});

describe("highlightCode", () => {
  it("returns null for unsupported languages without loading Shiki", async () => {
    await expect(highlightCode("fn main() {}", "brainfuck")).resolves.toBeNull();
  });

  it("returns null for empty code", async () => {
    await expect(highlightCode("  \n", "rust")).resolves.toBeNull();
  });
});
