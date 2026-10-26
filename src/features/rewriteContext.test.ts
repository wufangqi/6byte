import { describe, expect, it } from "vitest";
import { assembleRewrite, type RewriteSource } from "./rewriteContext";

const guide = [
  "# 安装",
  "使用 pnpm 安装依赖。",
  "",
  "## 启动",
  "运行 pnpm dev 启动编辑器。",
  "选中这句。",
  "",
  "## 发布",
  "运行 pnpm build。",
].join("\n");

function source(document: string, selection: string, filename: string): RewriteSource {
  const from = document.indexOf(selection);
  return { filename, document, from, to: from + selection.length };
}

describe("rewrite context", () => {
  it("sends the markdown section, filename, and heading outline", () => {
    const assembled = assembleRewrite(
      "选中这句。",
      "改短",
      source(guide, "选中这句。", "guide.md")
    );
    const user = assembled.messages[1].content;
    expect(assembled.messages[0].content).toContain("术语");
    expect(user).toContain("所在章节：");
    expect(user).toContain("## 启动");
    expect(user).toContain("pnpm dev");
    expect(user).toContain("选中这句。");
    expect(user).not.toContain("pnpm build");
    expect(user).toContain("文件：guide.md");
    expect(user).toContain("扩展名：.md");
    expect(user).toContain("# 安装");
    expect(user).toContain("## 发布");
    expect(assembled.parts.find((part) => part.id === "section")?.included).toBe(true);
    expect(assembled.parts.find((part) => part.id === "neighbors")?.available).toBe(false);
  });

  it("drops the outline when the user turns it off, and keeps the section heading", () => {
    const assembled = assembleRewrite(
      "选中这句。",
      "改短",
      source(guide, "选中这句。", "guide.md"),
      {
        exclude: ["outline"],
      }
    );
    const user = assembled.messages[1].content;
    expect(user).not.toContain("大纲：");
    expect(user).not.toContain("# 安装");
    expect(user).not.toContain("## 发布");
    expect(user).toContain("## 启动");
    expect(user).toContain("pnpm dev");
  });

  it("uses forty lines around the selection when the file is not markdown", () => {
    const lines = Array.from({ length: 100 }, (_, index) => `L${index + 1}`);
    const document = lines.join("\n");
    const assembled = assembleRewrite("L50", "改短", source(document, "L50", "notes.txt"));
    const user = assembled.messages[1].content;
    expect(user).toContain("邻近文字：");
    expect(user).toContain("L10");
    expect(user).toContain("L90");
    expect(user).not.toContain("L9\n");
    expect(user).not.toContain("L91");
    expect(user).not.toContain("大纲：");
    expect(assembled.parts.find((part) => part.id === "section")?.available).toBe(false);
  });

  it("uses neighbor lines for markdown that has no heading", () => {
    const lines = Array.from({ length: 100 }, (_, index) => `M${index + 1}`);
    const document = lines.join("\n");
    const user = assembleRewrite("M50", "改短", source(document, "M50", "plain.md")).messages[1]
      .content;
    expect(user).toContain("邻近文字：");
    expect(user).not.toContain("M1\n");
    expect(user).toContain("M10");
  });

  it("does not treat a heading inside a code fence as a section", () => {
    const document = ["```", "# 不是标题", "fence-body", "```", "", "正文选区"].join("\n");
    const user = assembleRewrite("正文选区", "改短", source(document, "正文选区", "note.md"))
      .messages[1].content;
    expect(user).toContain("邻近文字：");
    expect(user).not.toContain("大纲：");
    expect(user).not.toContain("所在章节：");
  });

  it("drops the outline before the filename and the section", () => {
    const headings = Array.from({ length: 40 }, (_, index) => `# 标题${index}占预算`);
    const document = [...headings, "", "## 启动", "运行 pnpm dev。", "选中这句。"].join("\n");
    const origin = source(document, "选中这句。", "guide.md");
    const none = assembleRewrite("选中这句。", "改短", origin, { extraBudget: 0 });
    expect(none.parts.filter((part) => part.included).map((part) => part.id)).toEqual([
      "selection",
    ]);
    expect(none.parts.find((part) => part.id === "outline")?.dropped).toBe(true);
    expect(none.messages[1].content).toContain("选中这句。");
    expect(none.messages[1].content).not.toContain("pnpm dev");
    expect(none.messages[1].content).not.toContain("# 标题0");

    const fitted = assembleRewrite("选中这句。", "改短", origin, { extraBudget: 200 });
    const kept = fitted.parts.filter((part) => part.included).map((part) => part.id);
    expect(kept).toEqual(["selection", "section", "filename"]);
    expect(fitted.messages[1].content).toContain("pnpm dev");
    expect(fitted.messages[1].content).toContain("文件：guide.md");
    expect(fitted.messages[1].content).not.toContain("# 标题0");
  });

  it("drops a file reference before the current outline", () => {
    const assembled = assembleRewrite(
      "选中这句。",
      "改短",
      source(guide, "选中这句。", "guide.md"),
      {
        extraBudget: 30,
        references: `引用文件：other.md\n大纲：\n${"# 别处".repeat(20)}`,
      }
    );
    expect(assembled.parts.find((part) => part.id === "references")?.dropped).toBe(true);
    expect(assembled.messages[1].content).not.toContain("别处");
    expect(assembled.messages[1].content).toContain("选中这句。");
  });

  it("never shortens the selection to fit the budget", () => {
    const selection = "选区".repeat(50);
    const user = assembleRewrite(selection, "改短", null, { extraBudget: 0 }).messages[1].content;
    expect(user).toContain(selection);
  });
});
