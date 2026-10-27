import { describe, expect, it } from "vitest";
import {
  AI_PANEL_DEFAULT_WIDTH,
  AI_PANEL_MAX_WIDTH,
  AI_PANEL_MIN_WIDTH,
  clampAiPanelWidth,
} from "./aiPanelLayout";

describe("clampAiPanelWidth", () => {
  it("uses the default for an invalid persisted width", () => {
    expect(clampAiPanelWidth(Number.NaN)).toBe(AI_PANEL_DEFAULT_WIDTH);
  });

  it("keeps the dock within its fixed bounds", () => {
    expect(clampAiPanelWidth(1)).toBe(AI_PANEL_MIN_WIDTH);
    expect(clampAiPanelWidth(AI_PANEL_MAX_WIDTH + 1)).toBe(AI_PANEL_MAX_WIDTH);
  });

  it("leaves space for the editor when the workspace is constrained", () => {
    expect(clampAiPanelWidth(640, 700)).toBe(380);
  });
});
