// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { tabFromFile } from "../stores/workspace";
import type { OpenedFile } from "../ipc/types";
import { markdownSourcePreferred, rememberMarkdownSource } from "./markdownView";

const file = (name: string): OpenedFile => ({
  path: `D:/tmp/${name}`,
  name,
  content: "# Hi\n",
  meta: { charset: "UTF-8", bom: false, eol: "lf", lossy: false, mixedEol: false },
  size: 5,
  mtimeMs: 1,
});

beforeEach(() => localStorage.clear());

describe("markdown view preference", () => {
  it("remembers the source choice without opening a file in the preview pane", () => {
    expect(markdownSourcePreferred()).toBe(false);
    rememberMarkdownSource(true);
    expect(markdownSourcePreferred()).toBe(true);
    const opened = tabFromFile(file("a.md"));
    expect(opened.source).toBe(true);
    expect(opened.preview).toBe(false);
    expect(opened.previewOf).toBeNull();
    expect(tabFromFile(file("c.txt")).source).toBe(true);
  });
});
