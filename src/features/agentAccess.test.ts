import { describe, expect, it } from "vitest";
import { blockedReason, parseDenylist, segmentsUnder } from "./agentAccess";

const ROOT = "D:\\repo";

describe("agent read access", () => {
  it("lets ordinary files through", () => {
    expect(blockedReason(ROOT, "D:\\repo\\README.md")).toBeNull();
    expect(blockedReason(ROOT, "D:\\repo\\src\\app.ts")).toBeNull();
    expect(blockedReason(ROOT, "D:\\repo")).toBeNull();
    expect(blockedReason("/home/me/repo", "/home/me/repo/docs/a.md")).toBeNull();
  });

  it("blocks hidden files and folders named by an explicit path", () => {
    expect(blockedReason(ROOT, "D:\\repo\\.env")).toBe("hidden");
    expect(blockedReason(ROOT, "D:\\repo\\.env.local")).toBe("hidden");
    expect(blockedReason(ROOT, "D:\\repo\\.git\\config")).toBe("hidden");
    expect(blockedReason(ROOT, "D:\\repo\\app\\.aws\\credentials")).toBe("hidden");
  });

  it("blocks key and credential files even when they are not hidden", () => {
    expect(blockedReason(ROOT, "D:\\repo\\certs\\server.pem")).toBe("secret");
    expect(blockedReason(ROOT, "D:\\repo\\deploy.KEY")).toBe("secret");
    expect(blockedReason(ROOT, "D:\\repo\\prod.env")).toBe("secret");
    expect(blockedReason(ROOT, "D:\\repo\\ssh\\id_rsa")).toBe("secret");
    expect(blockedReason(ROOT, "D:\\repo\\ssh\\id_ed25519.pub")).toBe("secret");
    expect(blockedReason(ROOT, "D:\\repo\\config\\credentials.json")).toBe("secret");
    expect(blockedReason(ROOT, "D:\\repo\\secrets\\a.txt")).toBe("secret");
  });

  it("does not block a document that merely mentions a secret", () => {
    expect(blockedReason(ROOT, "D:\\repo\\docs\\secrets.md")).toBeNull();
    expect(blockedReason(ROOT, "D:\\repo\\docs\\monkey.txt")).toBeNull();
  });

  it("refuses anything that is not under the root", () => {
    expect(blockedReason(ROOT, "D:\\other\\a.md")).toBe("outside");
    expect(blockedReason(ROOT, "D:\\repo2\\a.md")).toBe("outside");
    expect(blockedReason(ROOT, "D:\\repo\\..\\other\\a.md")).toBe("outside");
  });

  it("accepts Windows verbatim paths and mixed case from the file walk", () => {
    expect(blockedReason(ROOT, "\\\\?\\d:\\REPO\\src\\a.ts")).toBeNull();
    expect(blockedReason(ROOT, "\\\\?\\D:\\repo\\.env")).toBe("hidden");
  });

  it("applies the user's list to names, wildcards and folders", () => {
    const rules = ["private", "*.csv", "docs/draft/*", "# comment"];
    expect(blockedReason(ROOT, "D:\\repo\\private\\a.md", rules)).toBe("listed");
    expect(blockedReason(ROOT, "D:\\repo\\x\\private", rules)).toBe("listed");
    expect(blockedReason(ROOT, "D:\\repo\\data\\users.CSV", rules)).toBe("listed");
    expect(blockedReason(ROOT, "D:\\repo\\docs\\draft\\idea.md", rules)).toBe("listed");
    expect(blockedReason(ROOT, "D:\\repo\\docs\\final\\idea.md", rules)).toBeNull();
    expect(blockedReason(ROOT, "D:\\repo\\privately.md", rules)).toBeNull();
  });

  it("treats a folder rule as covering everything under it", () => {
    expect(blockedReason(ROOT, "D:\\repo\\docs\\draft\\deep\\a.md", ["docs/draft"])).toBe("listed");
    expect(blockedReason(ROOT, "D:\\repo\\docs\\draft", ["docs/draft/"])).toBe("listed");
  });

  it("parses the list: comments, blanks and duplicates are dropped", () => {
    expect(parseDenylist("a\r\n\n  b  \n# c\na")).toEqual(["a", "b"]);
    expect(parseDenylist(null)).toEqual([]);
  });

  it("reports segments under the root", () => {
    expect(segmentsUnder(ROOT, "D:\\repo\\a\\b.md")).toEqual(["a", "b.md"]);
    expect(segmentsUnder(ROOT, "D:\\repo")).toEqual([]);
    expect(segmentsUnder(ROOT, "D:\\elsewhere")).toBeNull();
  });
});
