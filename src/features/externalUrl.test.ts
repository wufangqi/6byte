import { describe, expect, it } from "vitest";
import { isSafeHttpUrl } from "./externalUrl";

describe("preview links", () => {
  it("allows web addresses and refuses everything else", () => {
    expect(isSafeHttpUrl("https://example.com/a")).toBe(true);
    expect(isSafeHttpUrl("http://127.0.0.1:9/x")).toBe(true);
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("file:///C:/secret.txt")).toBe(false);
    expect(isSafeHttpUrl("https://example.com/\ncalc")).toBe(false);
    expect(isSafeHttpUrl("./guide.md")).toBe(false);
    expect(isSafeHttpUrl("")).toBe(false);
  });
});
