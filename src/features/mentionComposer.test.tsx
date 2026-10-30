// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_META } from "../ipc/types";
import { useFileTree } from "../stores/fileTree";
import { useWorkspace } from "../stores/workspace";
import AiStreamPanel from "./AiStreamPanel";

vi.mock("../editor/registry", () => ({
  getEditorView: () => null,
  getSelectionSpan: () => ({ from: 0, to: 2, text: "正文" }),
  insertTextAtSelection: () => {},
  readBuffer: (_tabId: string, snapshot: string) => snapshot,
  subscribeDocChanges: () => () => {},
  subscribeSourceSelection: () => () => {},
}));

vi.mock("../ipc/api", () => ({
  aiCancel: vi.fn(async () => {}),
  aiStart: vi.fn(async () => "stream"),
  onAiToken: vi.fn(async () => () => {}),
  onAiDone: vi.fn(async () => () => {}),
  onAiError: vi.fn(async () => () => {}),
  listDirChildren: vi.fn(async () => ({
    entries: [
      {
        kind: "file",
        name: "AI-native-演进建议.md",
        path: "D:/repo/docs/AI-native-演进建议.md",
      },
    ],
  })),
  readFile: vi.fn(async () => "# 建议\n"),
}));

function setCaret(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.selectionStart = value.length;
  textarea.selectionEnd = value.length;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(textarea: HTMLTextAreaElement, key: string) {
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  textarea.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
}

describe("rewrite mention composer", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    useWorkspace.setState({
      tabs: [
        {
          id: "note",
          name: "note.md",
          path: "D:/repo/note.md",
          mode: "text",
          content: "# 安装\n正文\n## 启动\n",
          meta: DEFAULT_META,
          size: 16,
          mtimeMs: 0,
          dirty: false,
          lines: 3,
          chars: 16,
          version: 1,
          preview: true,
          source: true,
        },
      ],
      activeId: "note",
    });
    useFileTree.setState({ rootPath: "D:/repo", rootName: "repo" });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useFileTree.setState({ rootPath: null, rootName: "", root: null, selectedPath: null });
    useWorkspace.setState({ tabs: [], activeId: null });
  });

  async function renderPanel() {
    await act(async () => {
      root.render(
        <AiStreamPanel
          tabId="note"
          onClose={vi.fn()}
          onNeedSettings={vi.fn()}
          onOpenMatch={vi.fn()}
        />
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("moves the @ menu with the arrow keys and pins a highlighted file chip", async () => {
    await renderPanel();
    const textarea = host.querySelector("textarea");
    expect(textarea).toBeTruthy();
    if (!textarea) return;

    await act(async () => {
      setCaret(textarea, "@");
    });
    const options = () => [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options().length).toBeGreaterThan(1);
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");

    await act(async () => {
      press(textarea, "ArrowDown");
    });
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(options()[1]?.classList.contains("is-on")).toBe(true);

    await act(async () => {
      press(textarea, "ArrowUp");
    });
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");

    await act(async () => {
      setCaret(textarea, "@演进");
    });
    const file = options().find((option) => option.textContent?.includes("@docs/AI-native-演进建议.md"));
    expect(file?.getAttribute("aria-selected")).toBe("true");

    await act(async () => {
      press(textarea, "Enter");
    });

    expect(textarea.value).toBe("");
    expect(host.textContent).toContain("@docs/AI-native-演进建议.md");
    expect(host.textContent).not.toContain("@{file:");
    expect(host.querySelector('[role="listbox"]')).toBeNull();

    const chip = [...host.querySelectorAll(".ai-stream__chip--mention")].find((node) =>
      node.textContent?.includes("@docs/AI-native-演进建议.md")
    );
    expect(chip).toBeTruthy();

    await act(async () => {
      press(textarea, "Backspace");
    });
    expect(host.querySelector(".ai-stream__chip--mention")).toBeNull();
    expect(host.querySelector('[aria-label="移除选区上下文"]')).toBeTruthy();

    await act(async () => {
      press(textarea, "Backspace");
    });
    expect(host.querySelector('[aria-label="移除选区上下文"]')).toBeNull();
  });

  it("deletes the focused mention chip with the keyboard", async () => {
    await renderPanel();
    const textarea = host.querySelector("textarea");
    if (!textarea) return;
    await act(async () => {
      setCaret(textarea, "@演进");
      press(textarea, "Enter");
    });
    const button = host.querySelector<HTMLButtonElement>('[aria-label="移除引用"]');
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });
    expect(host.querySelector(".ai-stream__chip--mention")).toBeNull();
  });
});
