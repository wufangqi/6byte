import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t } from "../i18n/locale";
import { windowOwnsSession } from "./sessionOwner";
import type {
  FileChangeEvent,
  FileMeta,
  FileStat,
  AiDoneEvent,
  AiErrorEvent,
  AiStartRequest,
  AiTokenEvent,
  GrepResponse,
  LineRange,
  OpenDocument,
  OpenedFile,
  WriteResult,
} from "./types";

/** True when running inside the Tauri webview (false for plain `pnpm dev`). */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export { windowOwnsSession } from "./sessionOwner";

export function currentWindowOwnsSession(): boolean {
  if (!isTauri) return true;
  return windowOwnsSession(getCurrentWindow().label);
}

const textFilters = () => [
  {
    name: t("dialog.filter.text"),
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
  { name: t("dialog.filter.all"), extensions: ["*"] },
];

function requireTauri(actionKey: string): void {
  if (!isTauri) {
    throw new Error(t("ipc.requireTauri", { action: t(actionKey) }));
  }
}

/** Read a file, letting Rust decide the encoding. */
export async function readFile(path: string): Promise<OpenedFile> {
  requireTauri("ipc.read");
  return invoke<OpenedFile>("read_file", { path });
}

/**
 * Open a file with staged loading: small files come back whole, large ones as a
 * read-only descriptor whose content is streamed through {@link readRange}.
 */
export async function openDocument(path: string): Promise<OpenDocument> {
  requireTauri("ipc.read");
  return invoke<OpenDocument>("open_document", { path });
}

/** Decode lines `[startLine, endLine)` of a large file (0-based, end exclusive). */
export async function readRange(
  path: string,
  startLine: number,
  endLine: number
): Promise<LineRange> {
  requireTauri("ipc.read");
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
  requireTauri("ipc.save");
  return invoke<WriteResult>("write_file", { path, content, meta, allowLossy });
}

/** Current on-disk size and mtime, used to detect external edits before saving. */
export async function statFile(path: string): Promise<FileStat> {
  requireTauri("ipc.stat");
  return invoke<FileStat>("stat_file", { path });
}

/** Ask Rust to watch a file for external changes (emits `file-changed`). */
export async function watchFile(path: string): Promise<void> {
  requireTauri("ipc.watch");
  return invoke<void>("watch_file", { path });
}

/** Stop watching a file. */
export async function unwatchFile(path: string): Promise<void> {
  requireTauri("ipc.watch");
  return invoke<void>("unwatch_file", { path });
}

/** Subscribe to external file changes. Resolves to an unlisten function. */
export async function onFileChanged(
  handler: (event: FileChangeEvent) => void
): Promise<() => void> {
  if (!isTauri) return () => {};
  return listen<FileChangeEvent>("file-changed", (event) => handler(event.payload));
}

/**
 * Start a streaming chat completion. Resolves with a `streamId` immediately;
 * tokens arrive on `ai-token`, then `ai-done` or `ai-error`. The document
 * changes only after the caller writes the rewrite.
 */
export async function aiStart(request: AiStartRequest): Promise<string> {
  requireTauri("ipc.ai");
  return invoke<string>("ai_start", {
    providerId: request.providerId,
    baseUrl: request.baseUrl,
    apiKey: request.apiKey,
    model: request.model,
    messages: request.messages,
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    profileId: request.profileId,
  });
}

/** Store the API key in the OS keychain. It is not written to app settings. */
export async function aiSetKey(
  apiKey: string,
  profileId: string | undefined,
  baseUrl: string
): Promise<void> {
  requireTauri("ipc.ai");
  return invoke<void>("ai_set_key", { apiKey, profileId, baseUrl });
}

/** Origin a stored key may be sent to, or null when the key was saved before binding. */
export async function aiBoundOrigin(profileId?: string): Promise<string | null> {
  requireTauri("ipc.ai");
  return invoke<string | null>("ai_bound_origin", { profileId });
}

/** Forget the stored API key for one model. */
export async function aiClearKey(profileId?: string): Promise<void> {
  requireTauri("ipc.ai");
  return invoke<void>("ai_clear_key", { profileId });
}

/** Whether a key is already in the keychain. The key itself is not returned. */
export async function aiHasKey(profileId?: string): Promise<boolean> {
  requireTauri("ipc.ai");
  return invoke<boolean>("ai_has_key", { profileId });
}

/**
 * Send a one-token probe. A non-empty `apiKey` is used for this call only;
 * otherwise Rust reads the keychain. Returns the model's short reply, or "".
 */
export async function aiProbe(
  baseUrl: string,
  model: string,
  apiKey?: string,
  profileId?: string
): Promise<string> {
  requireTauri("ipc.ai");
  return invoke<string>("ai_probe", { baseUrl, model, apiKey, profileId });
}

/** Abort an in-flight model request. A finished id is ignored. */
export async function aiCancel(streamId: string): Promise<void> {
  requireTauri("ipc.ai");
  return invoke<void>("ai_cancel", { streamId });
}

export async function onAiToken(handler: (event: AiTokenEvent) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  return listen<AiTokenEvent>("ai-token", (event) => handler(event.payload));
}

export async function onAiDone(handler: (event: AiDoneEvent) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  return listen<AiDoneEvent>("ai-done", (event) => handler(event.payload));
}

export async function onAiError(handler: (event: AiErrorEvent) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  return listen<AiErrorEvent>("ai-error", (event) => handler(event.payload));
}

/** Search a directory tree with a Rust regex (binary files are skipped). */
export async function grepFiles(
  root: string,
  pattern: string,
  caseSensitive: boolean,
  maxResults?: number
): Promise<GrepResponse> {
  requireTauri("ipc.grep");
  return invoke<GrepResponse>("grep_files", { root, pattern, caseSensitive, maxResults });
}

/** Save a pasted image into `<dir>/assets/` and return its relative path. */
export async function saveAsset(dir: string, filename: string, bytes: number[]): Promise<string> {
  requireTauri("ipc.imageSave");
  return invoke<string>("save_asset", { dir, filename, bytes });
}

/** Read a local binary file as base64 (used to inline images as data URIs). */
export async function readBinaryBase64(path: string): Promise<string> {
  requireTauri("ipc.imageRead");
  return invoke<string>("read_binary_base64", { path });
}

export async function pickOpenPaths(): Promise<string[]> {
  const selected = await openDialog({
    multiple: true,
    directory: false,
    filters: textFilters(),
  });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

export async function pickSavePath(suggestedName: string): Promise<string | null> {
  const path = await saveDialog({
    defaultPath: suggestedName,
    filters: textFilters(),
  });
  return path ?? null;
}

export interface DirChild {
  name: string;
  path: string;
  kind: "dir" | "file";
}

export interface DirListing {
  entries: DirChild[];
  truncated: boolean;
  limit: number;
}

/** Immediate children of one directory. Hidden names, skipped dirs, and symlinks are omitted. */
export async function listDirChildren(path: string): Promise<DirListing> {
  requireTauri("ipc.folder");
  return invoke<DirListing>("list_dir_children", { path });
}

/** Reveal a path in the system file manager. */
export async function revealInOs(path: string): Promise<void> {
  requireTauri("ipc.folder");
  return invoke<void>("reveal_in_os", { path });
}

/** Open a fresh editor window. It does not reopen the files in this window. */
export async function openNewWindow(): Promise<void> {
  requireTauri("ipc.newWindow");
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const created = new WebviewWindow(`editor-${Date.now()}`, {
    url: "/",
    title: "6byte",
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 420,
    center: true,
    resizable: true,
    decorations: false,
    shadow: true,
    dragDropEnabled: true,
  });
  await new Promise<void>((resolve, reject) => {
    void created.once("tauri://created", () => resolve());
    void created.once("tauri://error", (event) => {
      reject(
        new Error(typeof event.payload === "string" ? event.payload : t("ipc.newWindowFailed"))
      );
    });
  });
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
