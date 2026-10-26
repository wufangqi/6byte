import { beforeEach, describe, expect, it } from "vitest";
import { armRewriteGate, disarmRewriteGate, dismissRewriteForSave } from "./rewriteGate";

describe("rewrite save gate", () => {
  beforeEach(() => {
    disarmRewriteGate("a");
    disarmRewriteGate("b");
  });

  it("dismisses only the tab that is being saved", () => {
    const dropped: string[] = [];
    armRewriteGate("a", () => dropped.push("a"));
    dismissRewriteForSave("b");
    expect(dropped).toEqual([]);
    dismissRewriteForSave("a");
    expect(dropped).toEqual(["a"]);
    dismissRewriteForSave("a");
    expect(dropped).toEqual(["a"]);
  });

  it("does not dismiss a gate that was already cleared", () => {
    let calls = 0;
    armRewriteGate("a", () => {
      calls += 1;
    });
    disarmRewriteGate("a");
    dismissRewriteForSave("a");
    expect(calls).toBe(0);
  });
});
