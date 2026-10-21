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

export const DEFAULT_META: FileMeta = {
  charset: "UTF-8",
  bom: false,
  eol: "lf",
  lossy: false,
};