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
  it("opens markdown in preview until the source has been shown", () => {
    expect(markdownSourcePreferred()).toBe(false);
    expect(tabFromFile(file("a.md")).source).toBe(false);
    rememberMarkdownSource(true);
    expect(tabFromFile(file("b.md")).source).toBe(true);
    expect(tabFromFile(file("c.txt")).source).toBe(true);
    rememberMarkdownSource(false);
    expect(tabFromFile(file("d.md")).preview).toBe(true);
    expect(tabFromFile(file("d.md")).source).toBe(false);
  });
});
