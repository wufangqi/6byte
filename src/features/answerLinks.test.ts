import { describe, expect, it } from "vitest";
import { answerReferences } from "./answerLinks";

describe("answer references", () => {
  it("extracts workspace-contained relative file and line references", () => {
    const answer = "先看 src/features/readAgent.ts:42，再看 docs/guide.md:7。";
    const references = answerReferences(answer, "D:\\work\\editor");

    expect(references).toEqual([
      {
        start: 3,
        end: 31,
        path: "D:\\work\\editor\\src\\features\\readAgent.ts",
        line: 42,
      },
      {
        start: 35,
        end: 50,
        path: "D:\\work\\editor\\docs\\guide.md",
        line: 7,
      },
    ]);
  });

  it("does not turn URLs or outside paths into navigation targets", () => {
    const answer = "访问 https://example.com:443，或 C:\\secret\\key.pem:3。";
    expect(answerReferences(answer, "D:\\work\\editor")).toEqual([]);
  });
});
