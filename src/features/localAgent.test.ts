import { describe, expect, it } from "vitest";
import {
  fitEditorText,
  fitSelection,
  mcpConfigText,
  EDITOR_TEXT_CAP,
  SELECTION_CAP,
} from "./localAgent";

describe("local agent snapshot", () => {
  it("keeps a normal document and drops an oversized body", () => {
    expect(fitEditorText("hello")).toEqual({ text: "hello", truncated: false });
    expect(fitEditorText("x".repeat(EDITOR_TEXT_CAP + 1))).toEqual({ text: "", truncated: true });
  });

  it("clips a huge selection", () => {
    expect(fitSelection("y".repeat(SELECTION_CAP + 5))).toHaveLength(SELECTION_CAP);
  });

  it("escapes a Windows path inside the MCP config", () => {
    const text = mcpConfigText("C:\\Users\\admin\\AppData\\Local\\6byte\\6byte-mcp.exe");
    expect(text).toContain(
      '"command": "C:\\\\Users\\\\admin\\\\AppData\\\\Local\\\\6byte\\\\6byte-mcp.exe"'
    );
    expect(JSON.parse(text).mcpServers["6byte"].command).toBe(
      "C:\\Users\\admin\\AppData\\Local\\6byte\\6byte-mcp.exe"
    );
  });
});
