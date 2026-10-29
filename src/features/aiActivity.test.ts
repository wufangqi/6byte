import { describe, expect, it } from "vitest";
import { getAiActivity, setAiActivity } from "./aiActivity";

describe("AI activity", () => {
  it("keeps the latest status for the status bar", () => {
    setAiActivity("idle");
    expect(getAiActivity()).toBe("idle");
    setAiActivity("generating");
    setAiActivity("generating");
    expect(getAiActivity()).toBe("generating");
    setAiActivity("review");
    expect(getAiActivity()).toBe("review");
    setAiActivity("idle");
    expect(getAiActivity()).toBe("idle");
  });
});
