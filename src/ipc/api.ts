import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { FileMeta, OpenedFile, WriteResult } from "./types";

/** True when running inside the Tauri webview (false for plain `pnpm dev`). */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const TEXT_FILTERS = [
  {
    name: "文本文件",
    extensions: ["md", "markdown", "txt", "log", "json", "yaml", "yml", "ini", "csv", "ts", "js", "rs", "py"],
  },
  { name: "所有文件", extensions: ["*"] },
];

/** Read a file, letting Rust decide the encoding. */
export async function readFile(path: string): Promise<OpenedFile> {
  if (!isTauri) throw new Error("文件读取需要 Tauri 运行时（请使用 pnpm tauri dev）");
  return invoke<OpenedFile>("read_file", { path });
}

/**
 * Write a file atomically, re-encoding with `meta.charset` / `meta.bom`
 * and normalising line endings to `meta.eol`.
 */
export async function writeFile(
  path: string,
  content: string,
  meta: FileMeta
): Promise<WriteResult> {
  if (!isTauri) throw new Error("文件保存需要 Tauri 运行时（请使用 pnpm tauri dev）");
  return invoke<WriteResult>("write_file", { path, content, meta });
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

/** Basename for display, works with both `/` and `\`. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}