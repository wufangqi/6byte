import { readBinaryBase64 } from "../ipc/api";

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};

/** Best-effort MIME type from a file extension (no I/O). */
export function mimeForPath(path: string): string {
  const match = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(path);
  const extension = match?.[1]?.toLowerCase();
  return (extension && MIME_BY_EXTENSION[extension]) || "application/octet-stream";
}

export function toDataUri(base64: string, mime: string): string {
  return `data:${mime};base64,${base64}`;
}

const cache = new Map<string, string>();

/** Drop cached data URIs (e.g. after the document directory changes). */
export function clearImageCache(): void {
  cache.clear();
}

/**
 * Read a local image through the Rust side and return a data URI. The preview and
 * the HTML export use this instead of the Tauri asset protocol, so no
 * `assetProtocol` scope has to be opened up.
 */
export async function loadImageDataUrl(path: string): Promise<string | null> {
  const cached = cache.get(path);
  if (cached) return cached;
  try {
    const base64 = await readBinaryBase64(path);
    const uri = toDataUri(base64, mimeForPath(path));
    cache.set(path, uri);
    return uri;
  } catch {
    return null;
  }
}
