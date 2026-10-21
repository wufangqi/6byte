import { describe, expect, it } from "vitest";
import { buildHtmlDocument, escapeHtml, htmlPathFor } from "./exportHtml";

describe("escapeHtml", () => {
  it("escapes the five HTML metacharacters", () => {
    expect(escapeHtml(`a & b < c > d "e" 'f'`)).toBe(
      "a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;"
    );
  });
});

describe("htmlPathFor", () => {
  it("replaces markdown extensions with .html", () => {
    expect(htmlPathFor("D:/notes/readme.md")).toBe("D:/notes/readme.html");
    expect(htmlPathFor("D:/notes/readme.markdown")).toBe("D:/notes/readme.html");
    expect(htmlPathFor("D:/notes/readme.mdx")).toBe("D:/notes/readme.html");
  });

  it("appends .html for other files", () => {
    expect(htmlPathFor("D:/notes/plain.txt")).toBe("D:/notes/plain.txt.html");
  });
});

describe("buildHtmlDocument", () => {
  it("produces a self-contained document with styles and rendered body", () => {
    const html = buildHtmlDocument("我的笔记", "# 标题\n\n正文");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>我的笔记</title>");
    expect(html).toContain("<style>");
    expect(html).toContain('<h1 id="标题">标题</h1>');
    expect(html).toContain("<p>正文</p>");
  });

  it("escapes the title and never emits raw HTML from the body", () => {
    const html = buildHtmlDocument('<script>alert("t")</script>', '<script>alert("x")</script>');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('<script>alert("t")</script>');
    expect(html).not.toContain('<script>alert("x")</script>');
  });

  it("falls back to a placeholder title", () => {
    const html = buildHtmlDocument("   ", "text");
    expect(html).toContain("<title>未命名文档</title>");
  });
});
