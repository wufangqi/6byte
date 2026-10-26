import { describe, expect, it } from "vitest";
import type { TreeNode } from "./fileTree";
import {
  activeMentionQuery,
  boundedFileExcerpt,
  buildReferences,
  collectWorkspaceFiles,
  filterPalette,
  grepDefaultRoot,
  insertMention,
  mentionToken,
  parseMentions,
  relativePath,
  resolveFileTarget,
  flattenTreeFiles,
  type PaletteItem,
} from "./workspaceQuery";

describe("workspace query", () => {
  it("searches the workspace root ahead of the file's own folder", () => {
    expect(grepDefaultRoot("D:/repo", "D:/repo/src")).toBe("D:/repo");
    expect(grepDefaultRoot(null, "D:/repo/src")).toBe("D:/repo/src");
    expect(grepDefaultRoot("  ", null)).toBeNull();
  });

  it("lists files already loaded in the tree and walks further directories up to the cap", async () => {
    const tree: TreeNode = {
      name: "repo",
      path: "/repo",
      kind: "dir",
      state: "ready",
      children: [{ name: "readme.md", path: "/repo/readme.md", kind: "file", state: "idle" }],
    };
    expect(flattenTreeFiles(tree).map((file) => file.name)).toEqual(["readme.md"]);

    const files = await collectWorkspaceFiles(
      "/repo",
      async (path) => {
        if (path === "/repo") {
          return {
            entries: [
              { name: "src", path: "/repo/src", kind: "dir" },
              { name: "readme.md", path: "/repo/readme.md", kind: "file" },
            ],
          };
        }
        return { entries: [{ name: "app.ts", path: "/repo/src/app.ts", kind: "file" }] };
      },
      10
    );
    expect(files.map((file) => file.name)).toEqual(["readme.md", "app.ts"]);
  });

  it("filters palette rows by name or path", () => {
    const items: PaletteItem[] = [
      { id: "1", kind: "file", label: "app.ts", detail: "src/app.ts", path: "/repo/src/app.ts" },
      { id: "2", kind: "heading", label: "安装", detail: "##", line: 4 },
    ];
    expect(filterPalette(items, "安装").map((item) => item.id)).toEqual(["2"]);
    expect(filterPalette(items, "src/app").map((item) => item.label)).toEqual(["app.ts"]);
  });

  it("inserts a mention token and parses it back", () => {
    const token = mentionToken({ kind: "heading", label: "启动", line: 4 });
    expect(token).toBe("@{heading:4:启动}");
    const inserted = insertMention("请改 @启", 5, "启", token);
    expect(inserted.text).toBe(`请改 ${token} `);
    expect(parseMentions(inserted.text)).toEqual([{ kind: "heading", label: "启动", line: 4 }]);
    expect(activeMentionQuery("请改 @rea", 7)).toBe("rea");
    expect(activeMentionQuery("请改 @{heading:4:启动} ", 20)).toBeNull();
  });

  it("names a markdown file by its headings and keeps a plain file to forty lines", () => {
    const markdown = boundedFileExcerpt("guide.md", "# 安装\n使用 pnpm。\n## 启动\n运行。\n");
    expect(markdown).toContain("# 安装");
    expect(markdown).toContain("## 启动");
    expect(markdown).not.toContain("使用 pnpm");
    const lines = Array.from({ length: 50 }, (_, index) => `L${index + 1}`);
    const plain = boundedFileExcerpt("notes.txt", lines.join("\n"));
    expect(plain).toContain("L40");
    expect(plain).not.toContain("L41");
  });

  it("sends a heading's section and refuses a file that is not in the workspace", async () => {
    const document = ["# 安装", "使用 pnpm。", "", "# 发布", "pnpm build"].join("\n");
    const files = [{ name: "guide.md", path: "D:/repo/guide.md" }];
    const text = await buildReferences(
      [
        { kind: "heading", label: "安装", line: 1 },
        { kind: "file", label: "secret.txt" },
        { kind: "file", label: "guide.md" },
      ],
      document,
      files,
      "D:/repo",
      async () => ({ name: "guide.md", content: "# 安装\n只有大纲。\n正文不发。\n" })
    );
    expect(text).toContain("引用大纲：安装");
    expect(text).toContain("使用 pnpm。");
    expect(text).not.toContain("pnpm build");
    expect(text).toContain("secret.txt");
    expect(text).toContain("不在当前工作区");
    expect(text).toContain("# 安装");
    expect(text).not.toContain("正文不发");
    expect(relativePath("D:/repo", "D:/repo/guide.md")).toBe("guide.md");
    expect(resolveFileTarget(files, "D:/repo", "guide.md")).toBe("D:/repo/guide.md");
  });
});
