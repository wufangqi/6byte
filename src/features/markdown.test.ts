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
});
