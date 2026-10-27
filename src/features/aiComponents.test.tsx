import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import AgentAnswer from "./AgentAnswer";
import AiStreamPanel from "./AiStreamPanel";
import CommandPalette from "./CommandPalette";

describe("AI component render smoke tests", () => {
  it("renders the stream panel without a configured model", () => {
    const html = renderToStaticMarkup(
      <AiStreamPanel
        tabId="missing-tab"
        onClose={vi.fn()}
        onNeedSettings={vi.fn()}
        onOpenMatch={vi.fn()}
      />
    );

    expect(html).toContain("模型回复");
    expect(html).toContain("询问");
    expect(html).toContain("请先在文档里选中一段文字。");
  });

  it("renders the command palette dialog", () => {
    const html = renderToStaticMarkup(
      <CommandPalette onClose={vi.fn()} onOpenFile={vi.fn()} onRevealLine={vi.fn()} />
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain("转到文件或标题");
  });

  it("renders safe file-line references and answer follow-up actions", () => {
    const html = renderToStaticMarkup(
      <AgentAnswer
        answer="见 src/readAgent.ts:12。"
        workspaceRoot="D:\\repo"
        onOpenMatch={vi.fn()}
        onInsert={vi.fn()}
        onConvertToRewrite={vi.fn()}
      />
    );

    expect(html).toContain("src/readAgent.ts:12");
    expect(html).toContain("插入到光标");
    expect(html).toContain("转为改写");
  });
});
