import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildHtmlDocument,
  escapeHtml,
  htmlPathFor,
  inlineLocalImages,
  renderExportBody,
  type ExportRenderers,
} from "./exportHtml";

const parityFixture = readFileSync(
  new URL("./fixtures/markdown-preview-export-parity.md", import.meta.url),
  "utf8"
);

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
  it("produces a self-contained document with styles and rendered body", async () => {
    const html = await buildHtmlDocument("我的笔记", "# 标题\n\n正文");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>我的笔记</title>");
    expect(html).toContain("<style>");
    expect(html).toContain('<h1 id="标题">标题</h1>');
    expect(html).toContain("<p>正文</p>");
  });

  it("escapes the title and never emits raw HTML from the body", async () => {
    const html = await buildHtmlDocument(
      '<script>alert("t")</script>',
      '<script>alert("x")</script>'
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('<script>alert("t")</script>');
    expect(html).not.toContain('<script>alert("x")</script>');
  });

  it("bakes the light palette into the stylesheet", async () => {
    const html = await buildHtmlDocument("笔记", "正文", { theme: "light" });
    expect(html).toContain("color-scheme: light");
    expect(html).toContain("#f3f4f7");
  });

  it("falls back to a placeholder title", async () => {
    const html = await buildHtmlDocument("   ", "text");
    expect(html).toContain("<title>未命名文档</title>");
  });

  it("bakes supported Shiki and KaTeX output into the saved HTML", async () => {
    const html = await buildHtmlDocument("笔记", "```js\nconst n = 1;\n```\n\n$E=mc^2$");
    expect(html).toContain('class="shiki');
    expect(html).toContain("<math");
  }, 120000);
});

describe("renderExportBody", () => {
  it("uses the shared preview/export fixture and upgrades every enhanced block", async () => {
    const calls: string[] = [];
    const renderers: ExportRenderers = {
      highlight: async (_source, language, theme) => {
        calls.push(`highlight:${language}:${theme}`);
        return '<pre class="shiki">highlighted</pre>';
      },
      katex: async (_visible, display) => {
        calls.push(`katex:${display}`);
        return `<math data-display="${display}"></math>`;
      },
      mermaid: async (_source, theme) => {
        calls.push(`mermaid:${theme}`);
        return '<svg data-diagram="ok"></svg>';
      },
    };

    const body = await renderExportBody(
      parityFixture,
      { baseDir: "D:\\repo\\src\\features\\fixtures", theme: "light" },
      renderers
    );

    expect(calls).toEqual(
      expect.arrayContaining([
        "highlight:typescript:light",
        "katex:false",
        "katex:true",
        "mermaid:light",
      ])
    );
    expect(body).toContain('id="markdown-预览与导出一致性样例"');
    expect(body).toContain('<pre class="shiki">highlighted</pre>');
    expect(body).toContain('<math data-display="false"></math>');
    expect(body).toContain('<math data-display="true"></math>');
    expect(body).toContain('<div class="mermaid-diagram"><svg data-diagram="ok"></svg></div>');
    expect(body).toContain("data-local-path=");
  });

  it("marks failed formula and diagram rendering instead of silently exporting placeholders", async () => {
    const unavailable: ExportRenderers = {
      highlight: async () => null,
      katex: async () => null,
      mermaid: async () => null,
    };
    const body = await renderExportBody("$$x$$\n\n```mermaid\ngraph TD\n```", {}, unavailable);

    expect(body).toContain("export-render-fallback");
    expect(body).toContain("export-render-fallback--math");
    expect(body).toContain("language-mermaid");
  });
});

describe("inlineLocalImages", () => {
  const html =
    '<p><img src="assets/shot.png" alt="shot" data-local-path="D:\\\\docs\\\\assets\\\\shot.png"></p>';

  it("replaces local images with data URIs", async () => {
    const result = await inlineLocalImages(html, async (path) => {
      expect(path).toBe("D:\\\\docs\\\\assets\\\\shot.png");
      return "data:image/png;base64,AQID";
    });
    expect(result).toContain('src="data:image/png;base64,AQID"');
    expect(result).not.toContain("data-local-path");
  });

  it("replaces an unreadable local image with a clear export fallback", async () => {
    const result = await inlineLocalImages(html, async () => null);
    expect(result).toContain("export-image-fallback");
    expect(result).toContain("assets/shot.png");
    expect(result).not.toContain("D:\\\\docs\\\\assets\\\\shot.png");
    expect(result).not.toContain("data-local-path");
    expect(result).not.toContain("<img");
  });

  it("uses the same fallback when the local image read throws", async () => {
    const result = await inlineLocalImages(html, async () => {
      throw new Error("permission denied");
    });
    expect(result).toContain("export-image-fallback");
    expect(result).not.toContain("<img");
  });

  it("leaves remote images alone", async () => {
    const remote = '<img src="https://example.com/a.png">';
    await expect(inlineLocalImages(remote, async () => "data:image/png;base64,AA")).resolves.toBe(
      remote
    );
  });
});

describe("buildHtmlDocument with images", () => {
  it("marks local image paths for inlining when a base dir is given", async () => {
    const doc = await buildHtmlDocument("t", "![shot](assets/shot.png)", { baseDir: "D:/docs" });
    expect(doc).toContain('data-local-path="D:/docs/assets/shot.png"');
  });
});
