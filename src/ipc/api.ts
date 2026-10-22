import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  FileChangeEvent,
  FileMeta,
  FileStat,
  GrepResponse,
  LineRange,
  OpenDocument,
  OpenedFile,
  WriteResult,
} from "./types";

/** True when running inside the Tauri webview (false for plain `pnpm dev`). */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const TEXT_FILTERS = [
  {
    name: "文本文件",
    extensions: [
      "md",
      "markdown",
      "txt",
      "log",
      "json",
      "yaml",
      "yml",
      "ini",
      "csv",
      "ts",
      "js",
      "rs",
      "py",
    ],
  },
  { name: "所有文件", extensions: ["*"] },
];

function requireTauri(action: string): void {
  if (!isTauri) {
    throw new Error(`${action}需要 Tauri 运行时（请使用 pnpm tauri dev 或安装版）`);
  }
}

/** Read a file, letting Rust decide the encoding. */
export async function readFile(path: string): Promise<OpenedFile> {
  requireTauri("文件读取");
  return invoke<OpenedFile>("read_file", { path });
}

/**
 * Open a file with staged loading: small files come back whole, large ones as a
 * read-only descriptor whose content is streamed through {@link readRange}.
 */
export async function openDocument(path: string): Promise<OpenDocument> {
  requireTauri("文件读取");
  return invoke<OpenDocument>("open_document", { path });
}

/** Decode lines `[startLine, endLine)` of a large file (0-based, end exclusive). */
export async function readRange(
  path: string,
  startLine: number,
  endLine: number
): Promise<LineRange> {
  requireTauri("文件读取");
  return invoke<LineRange>("read_range", { path, startLine, endLine });
}

/**
 * Write a file atomically, re-encoding with `meta.charset` / `meta.bom`
 * and normalising line endings to `meta.eol`.
 *
 * `allowLossy` must only be true after the user explicitly confirmed that a
 * lossily decoded buffer may overwrite the original bytes.
 */
export async function writeFile(
  path: string,
  content: string,
  meta: FileMeta,
  allowLossy = false
): Promise<WriteResult> {
  requireTauri("文件保存");
  return invoke<WriteResult>("write_file", { path, content, meta, allowLossy });
}

/** Current on-disk size and mtime, used to detect external edits before saving. */
export async function statFile(path: string): Promise<FileStat> {
  requireTauri("文件状态读取");
  return invoke<FileStat>("stat_file", { path });
}

/** Ask Rust to watch a file for external changes (emits `file-changed`). */
export async function watchFile(path: string): Promise<void> {
  requireTauri("文件监听");
  return invoke<void>("watch_file", { path });
}

/** Stop watching a file. */
export async function unwatchFile(path: string): Promise<void> {
  requireTauri("文件监听");
  return invoke<void>("unwatch_file", { path });
}

/** Subscribe to external file changes. Resolves to an unlisten function. */
export async function onFileChanged(
  handler: (event: FileChangeEvent) => void
): Promise<() => void> {
  if (!isTauri) return () => {};
  return listen<FileChangeEvent>("file-changed", (event) => handler(event.payload));
}

/** Search a directory tree with a Rust regex (binary files are skipped). */
export async function grepFiles(
  root: string,
  pattern: string,
  caseSensitive: boolean,
  maxResults?: number
): Promise<GrepResponse> {
  requireTauri("跨文件搜索");
  return invoke<GrepResponse>("grep_files", { root, pattern, caseSensitive, maxResults });
}

/** Save a pasted image into `<dir>/assets/` and return its relative path. */
export async function saveAsset(dir: string, filename: string, bytes: number[]): Promise<string> {
  requireTauri("图片保存");
  return invoke<string>("save_asset", { dir, filename, bytes });
}

/** Read a local binary file as base64 (used to inline images as data URIs). */
export async function readBinaryBase64(path: string): Promise<string> {
  requireTauri("图片读取");
  return invoke<string>("read_binary_base64", { path });
}

export async function pickOpenPaths(): Promise<string[]> {
  const selected = await openDialog({
    multiple: true,
    directory: false,
    filters: TEXT_FILTERS,
  });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

export async function pickSavePath(suggestedName: string): Promise<string | null> {
  const path = await saveDialog({
    defaultPath: suggestedName,
    filters: TEXT_FILTERS,
  });
  return path ?? null;
}

/** Pick a folder (used as the cross-file search root). */
export async function pickDirectory(): Promise<string | null> {
  const selected = await openDialog({ directory: true, multiple: false });
  if (!selected) return null;
  return Array.isArray(selected) ? (selected[0] ?? null) : selected;
}

export interface DropHandlers {
  onOver(): void;
  onLeave(): void;
  onDrop(paths: string[]): void;
}

/** Subscribe to native drag & drop. Resolves to an unlisten function. */
export async function onFileDrop(handlers: DropHandlers): Promise<() => void> {
  if (!isTauri) return () => {};
  return getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "over") handlers.onOver();
    else if (event.payload.type === "drop") handlers.onDrop(event.payload.paths);
    else handlers.onLeave();
  });
}

/**
 * Intercept window close. The handler resolves `true` when the window may close;
 * the window is always destroyed by this wrapper after a `true` answer, so the
 * caller can await dialogs/saves without racing the native close.
 */
export async function onCloseRequested(handler: () => Promise<boolean>): Promise<() => void> {
  if (!isTauri) return () => {};
  const win = getCurrentWindow();
  return win.onCloseRequested(async (event) => {
    event.preventDefault();
    if (await handler()) {
      await win.destroy();
    }
  });
}
