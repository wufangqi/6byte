import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders headings and paragraphs", () => {
    const html = renderMarkdown("# Title\n\nhello");
    expect(html).toContain('<h1 id="title">Title</h1>');
    expect(html).toContain("<p>hello</p>");
  });

  it("renders inline emphasis and code", () => {
    const html = renderMarkdown("**bold** and `code`");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
  });

  it("keeps the fence language as a class and escapes the code", () => {
    const html = renderMarkdown('```js\nconst a = 1 < 2 && "x";\n```');
    expect(html).toContain('class="language-js"');
    expect(html).toContain("&lt; 2");
    expect(html).not.toContain("<script");
  });

  it("does not pass raw HTML through", () => {
    const html = renderMarkdown('<script>alert("x")</script>\n\n<b>bold?</b>');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>bold?</b>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("autolinks bare URLs", () => {
    const html = renderMarkdown("see https://example.com/docs");
    expect(html).toContain('href="https://example.com/docs"');
  });

  it("renders blockquotes and lists", () => {
    const html = renderMarkdown("> quote\n\n- one\n- two\n");
    expect(html).toContain("<blockquote>");
    expect(html.match(/<li>/g)).toHaveLength(2);
  });

  it("gives headings stable, deduplicated ids for the outline", () => {
    const html = renderMarkdown("# Intro\n\n## Intro\n\n## **Bold** heading\n");
    expect(html).toContain('<h1 id="intro">');
    expect(html).toContain('<h2 id="intro-1">');
    expect(html).toContain('<h2 id="bold-heading">');
  });

  it("decodes Chinese image paths before resolving them", () => {
    const html = renderMarkdown("![图](团建/方案.png)", { baseDir: "D:\\docs" });
    expect(html).toContain('data-local-path="D:\\docs\\团建\\方案.png"');
  });

  it("resolves an image path that contains spaces", () => {
    const html = renderMarkdown("![图](团建和附件/方案 V-3.png)", { baseDir: "D:\\docs" });
    expect(html).toContain("<img ");
    expect(html).toContain('data-local-path="D:\\docs\\团建和附件\\方案 V-3.png"');
  });

  it("keeps the title on a spaced image path", () => {
    const html = renderMarkdown('![图](团建/方案 V-3.png "标题")', { baseDir: "D:\\docs" });
    expect(html).toContain('data-local-path="D:\\docs\\团建\\方案 V-3.png"');
    expect(html).toContain('title="标题"');
  });

  it("resolves parentheses inside a spaced image path", () => {
    const html = renderMarkdown("![图](团建/方案 (1).png)", { baseDir: "D:\\docs" });
    expect(html).toContain('data-local-path="D:\\docs\\团建\\方案 (1).png"');
  });

  it("decodes spaces in bracketed image paths", () => {
    const html = renderMarkdown("![图](<团建/方案 V-3.png>)", { baseDir: "D:\\docs" });
    expect(html).toContain('data-local-path="D:\\docs\\团建\\方案 V-3.png"');
  });

  it("marks local image paths with an absolute data-local-path", () => {
    const html = renderMarkdown("![shot](assets/shot.png)", {
      baseDir: "D:\\docs\\notes",
    });
    expect(html).toContain('data-local-path="D:\\docs\\notes\\assets\\shot.png"');
    expect(html).toContain('src="assets/shot.png"');
  });

  it("leaves remote and absolute image sources alone", () => {
    const html = renderMarkdown("![remote](https://example.com/a.png)", {
      baseDir: "D:/docs",
    });
    expect(html).not.toContain("data-local-path");
  });

  it("does not resolve images without a base directory", () => {
    const html = renderMarkdown("![shot](assets/shot.png)");
    expect(html).not.toContain("data-local-path");
  });

  it("marks inline and display math without rendering it", () => {
    const html = renderMarkdown("see $E=mc^2$ and $$a^2+b^2$$.");
    expect(html).toContain('<span class="math-inline">$E=mc^2$</span>');
    expect(html).toContain('<span class="math-inline math-display">$$a^2+b^2$$</span>');
  });

  it("lifts a whole-line display formula into a block", () => {
    const html = renderMarkdown("$$E=mc^2$$");
    expect(html).toContain('<div class="math-block">$$E=mc^2$$</div>');
  });

  it("marks a fenced math block and escapes its source", () => {
    const html = renderMarkdown("$$\na < b\n$$");
    expect(html).toContain('<div class="math-block">$$a &lt; b$$</div>');
    expect(html).not.toContain("<b>");
  });

  it("does not treat spaced dollars or inline code as math", () => {
    const prices = renderMarkdown("price is $5 and $10 today");
    expect(prices).not.toContain("math-inline");
    expect(prices).toContain("$5 and $10");

    const code = renderMarkdown("use `$x$` in a sentence");
    expect(code).not.toContain("math-inline");
    expect(code).toContain("<code>$x$</code>");
  });

  it("keeps a mermaid fence as an escaped code block", () => {
    const html = renderMarkdown("```mermaid\ngraph TD\n  A-->B\n```");
    expect(html).toContain('class="language-mermaid"');
    expect(html).toContain("A--&gt;B");
  });
});
