import { describe, expect, it } from "vitest";
import { documentQuestion } from "./documentAsk";

describe("current-document question", () => {
  it("sends the file and forbids looking at the rest of the workspace", () => {
    const messages = documentQuestion("note.md", "正文", "这一节在说什么？", 8000);
    expect(messages[0].content).toContain("不要读取");
    expect(messages[1].content).toContain("文件：note.md");
    expect(messages[1].content).toContain("正文");
    expect(messages[1].content).toContain("这一节在说什么？");
    expect(messages[1].content).not.toContain("只包含开头");
  });

  it("cuts a long document and says so", () => {
    const messages = documentQuestion("long.md", "甲".repeat(500), "总结", 80);
    expect(messages[1].content.length).toBeLessThan(500);
    expect(messages[1].content).toContain("只包含开头");
  });
});
