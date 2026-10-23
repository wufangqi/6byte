export type Eol = "lf" | "crlf" | "cr";

export interface FileMeta {
  /** Encoding label as reported by Rust, e.g. "UTF-8" | "GBK" | "UTF-16LE" */
  charset: string;
  /** Whether the file starts with a byte order mark */
  bom: boolean;
  /** Dominant line ending of the file */
  eol: Eol;
  /** True when the file contained bytes that could not be decoded */
  lossy: boolean;
  /** True when the file mixed CRLF/LF/CR; saving normalizes to `eol` */
  mixedEol: boolean;
}

export interface OpenedFile {
  path: string;
  name: string;
  content: string;
  meta: FileMeta;
  size: number;
  mtimeMs: number;
}

export interface WriteResult {
  size: number;
  mtimeMs: number;
  meta: FileMeta;
}

export interface FileStat {
  size: number;
  mtimeMs: number;
}

/** `text` documents are edited in CodeMirror; `large` ones are read-only ranges. */
export type DocumentMode = "text" | "large";

export interface LargeFileInfo {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  meta: FileMeta;
  lineCount: number;
}

export type OpenDocument =
  { mode: "text"; file: OpenedFile } | { mode: "large"; info: LargeFileInfo };

export interface LineRange {
  startLine: number;
  lines: string[];
}

/** Payload of the `file-changed` event emitted by the Rust file watcher. */
export interface FileChangeEvent {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface GrepMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface GrepResponse {
  matches: GrepMatch[];
  filesScanned: number;
  filesMatched: number;
  truncated: boolean;
  elapsedMs: number;
}

/** One turn sent to an OpenAI-compatible provider. */
export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiStartRequest {
  /** Currently only `openai-compatible`. */
  providerId: string;
  /** API root, for example `https://api.openai.com/v1` or `http://127.0.0.1:11434/v1`. */
  baseUrl: string;
  apiKey?: string;
  model: string;
  messages: AiMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Keychain slot. The legacy install uses `default`. */
  profileId?: string;
}

export interface AiTokenEvent {
  streamId: string;
  delta: string;
  /** `reasoning` is the thinking trace. Anything else is the rewrite. */
  kind?: string;
}

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface AiDoneEvent {
  streamId: string;
  usage?: AiUsage;
}

export interface AiErrorEvent {
  streamId: string;
  code: string;
  message: string;
}

export const DEFAULT_META: FileMeta = {
  charset: "UTF-8",
  bom: false,
  eol: "lf",
  lossy: false,
  mixedEol: false,
};
