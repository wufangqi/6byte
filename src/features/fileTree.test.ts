import { describe, expect, it } from "vitest";
import {
  canExpand,
  clampTreeWidth,
  MAX_EXPANDED_DIRS,
  MAX_TREE_NODES,
  pageRows,
  parseTreeHidden,
  parseTreeWidth,
  pathInsideRoot,
  sortTreeEntries,
  TREE_PAGE_SIZE,
  treeContextActions,
  treeHighlights,
  visibleTreeRows,
  type TreeNode,
} from "./fileTree";

describe("tree context menu", () => {
  it("offers rename only for files", () => {
    expect(treeContextActions("file")).toContain("rename");
    expect(treeContextActions("dir")).not.toContain("rename");
  });
});

describe("tree width and collapse", () => {
  it("clamps the width and falls back when the stored value is unusable", () => {
    expect(parseTreeWidth(null)).toBe(240);
    expect(parseTreeWidth("nope")).toBe(240);
    expect(parseTreeWidth("200")).toBe(200);
    expect(parseTreeWidth("10")).toBe(160);
    expect(parseTreeWidth("900")).toBe(400);
    expect(clampTreeWidth(Number.NaN)).toBe(240);
  });

  it("treats only the stored flag as hidden", () => {
    expect(parseTreeHidden(null)).toBe(false);
    expect(parseTreeHidden("0")).toBe(false);
    expect(parseTreeHidden("1")).toBe(true);
  });
});

describe("tree ordering and highlight", () => {
  it("puts directories before files and orders each group with the locale", () => {
    const sorted = sortTreeEntries(
      [
        { name: "b.txt", kind: "file" as const },
        { name: "zeta", kind: "dir" as const },
        { name: "a.txt", kind: "file" as const },
        { name: "alpha", kind: "dir" as const },
      ],
      "en"
    );
    expect(sorted.map((entry) => entry.name)).toEqual(["alpha", "zeta", "a.txt", "b.txt"]);
  });

  it("highlights the active file only when it is inside the root", () => {
    expect(treeHighlights("D:\\notes", "D:\\notes\\a.md", "D:\\notes\\a.md")).toBe(true);
    expect(treeHighlights("D:\\notes", "D:/notes/a.md", "D:\\notes\\a.md")).toBe(true);
    expect(treeHighlights("D:\\notes", "D:\\other\\a.md", "D:\\other\\a.md")).toBe(false);
    expect(treeHighlights("D:\\notes", "D:\\notes-extra\\a.md", "D:\\notes-extra\\a.md")).toBe(
      false
    );
    expect(pathInsideRoot("/work/docs", "/work/docs/a.md")).toBe(true);
    expect(pathInsideRoot("/work/docs", "/work/docs-extra/a.md")).toBe(false);
  });

  it("matches verbatim Windows paths against dialog paths", () => {
    expect(pathInsideRoot("C:\\notes", "\\\\?\\C:\\notes\\a.md")).toBe(true);
    expect(treeHighlights("C:\\notes", "C:\\notes\\a.md", "\\\\?\\C:\\notes\\a.md")).toBe(true);
    expect(pathInsideRoot("\\\\server\\share", "\\\\?\\UNC\\server\\share\\a.md")).toBe(true);
  });
});

describe("tree rendering caps", () => {
  it("pages a long directory instead of rendering every row", () => {
    const rows = Array.from({ length: 2_000 }, (_, index) => index);
    expect(pageRows(rows, TREE_PAGE_SIZE)).toHaveLength(300);
    expect(pageRows(rows, TREE_PAGE_SIZE)[0]).toBe(0);
  });

  it("walks only expanded directories", () => {
    const child: TreeNode = { name: "a.md", path: "/r/a.md", kind: "file", state: "idle" };
    const closed: TreeNode = {
      name: "hidden",
      path: "/r/hidden",
      kind: "dir",
      state: "ready",
      expanded: false,
      children: [child],
    };
    const open: TreeNode = {
      name: "open",
      path: "/r/open",
      kind: "dir",
      state: "ready",
      expanded: true,
      children: [child],
    };
    const rows = visibleTreeRows([closed, open]);
    expect(rows.map((row) => row.node.name)).toEqual(["hidden", "open", "a.md"]);
    expect(rows[2]?.depth).toBe(1);
  });

  it("stops expanding at the directory and node caps", () => {
    expect(canExpand({ nodes: 10, expanded: 1 }, 3)).toBe(true);
    expect(canExpand({ nodes: 10, expanded: MAX_EXPANDED_DIRS }, 1)).toBe(false);
    expect(canExpand({ nodes: MAX_TREE_NODES, expanded: 1 }, 1)).toBe(false);
  });
});
