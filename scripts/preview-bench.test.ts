import { performance } from "node:perf_hooks";
import { describe, it } from "vitest";
import { extractHeadings } from "../src/features/outline";
import { renderMarkdown } from "../src/features/markdown";
import { previewSlice, WINDOW_CHARS } from "../src/features/previewWindow";

/** A technical chapter, repeated until the document reaches `targetBytes`. */
function chapter(index: number): string {
  return [
    `# 第 ${index} 章 预览与上下文`,
    "",
    "这一章记录一次改写从选区到候选的路径。正文保持原编码，候选在接受前不写入文件。",
    "",
    "## 读取边界",
    "",
    "隐藏文件、密钥文件和用户列出的名字不会被读到。目录列表里同样不出现。",
    "",
    "- 取消会停掉当前请求",
    "- 失败不会改动正文",
    "- 最近几轮对话只留在本机",
    "",
    "```ts",
    "export function fits(prompt: number, window: number): boolean {",
    "  return window - prompt >= 256;",
    "}",
    "```",
    "",
    "| 项 | 说明 |",
    "| --- | --- |",
    `| 章节 | ${index} |`,
    "| 选区 | 不截断 |",
    "",
    "收尾段说明预览只反映已经写进编辑器的文字。",
    "",
  ].join("\n");
}

function documentOf(targetBytes: number): string {
  let text = "";
  let index = 1;
  while (Buffer.byteLength(text, "utf8") < targetBytes) {
    text += chapter(index);
    index += 1;
  }
  return text;
}

const TARGETS = [
  ["100 KB", 100 * 1024],
  ["1 MB", 1024 * 1024],
  ["5 MB", 5 * 1024 * 1024],
] as const;

describe("preview render bench", () => {
  for (const [label, bytes] of TARGETS) {
    it(label, () => {
      const source = documentOf(bytes);
      const renderStart = performance.now();
      const html = renderMarkdown(source, { sourceLines: true });
      const renderMs = performance.now() - renderStart;
      const outlineStart = performance.now();
      const headings = extractHeadings(source);
      const outlineMs = performance.now() - outlineStart;
      let middleLine = 0;
      const middle = Math.floor(source.length / 2);
      for (let index = 0; index < middle; index += 1) {
        if (source.charCodeAt(index) === 10) middleLine += 1;
      }
      const windowStart = performance.now();
      const slice = previewSlice(source, middleLine, WINDOW_CHARS);
      const windowHtml = renderMarkdown(slice.text, {
        sourceLines: true,
        lineOffset: slice.startLine,
      });
      const windowMs = performance.now() - windowStart;
      const heap = process.memoryUsage().heapUsed;
      console.log(
        JSON.stringify({
          label,
          sourceBytes: Buffer.byteLength(source, "utf8"),
          sourceChars: source.length,
          htmlChars: html.length,
          headings: headings.length,
          fullRenderMs: Math.round(renderMs),
          outlineMs: Math.round(outlineMs),
          windowChars: slice.text.length,
          windowHtmlChars: windowHtml.length,
          windowMs: Math.round(windowMs),
          heapMb: Math.round(heap / (1024 * 1024)),
        })
      );
    });
  }
});
