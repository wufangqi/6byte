/**
 * Pure helpers for working with remote paths encoded as SSH URIs.
 *
 * Format: `ssh://<profileId>/<absolute-posix-path>`
 *
 * These functions never touch the filesystem or call Tauri; they are safe to
 * unit-test in Node.
 */

const SSH_PREFIX = "ssh://";

/** True when the path is an SSH URI (`ssh://<profileId>/...`). */
export function isSshUri(path: string): boolean {
  return path.startsWith(SSH_PREFIX);
}

/**
 * Parse an SSH URI into its profile id and remote POSIX path.
 * Returns `null` when the string is not a valid SSH URI.
 */
export function parseSshUri(uri: string): { profileId: string; remotePath: string } | null {
  if (!uri.startsWith(SSH_PREFIX)) return null;
  const rest = uri.slice(SSH_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const profileId = rest.slice(0, slash);
  if (!profileId) return null;
  const remotePath = rest.slice(slash);
  if (!remotePath.startsWith("/")) return null;
  return { profileId, remotePath };
}

/** Build an SSH URI from a profile id and a remote POSIX path. */
export function buildSshUri(profileId: string, remotePath: string): string {
  return `${SSH_PREFIX}${profileId}${remotePath.startsWith("/") ? "" : "/"}${remotePath}`;
}

// ---------------------------------------------------------------------------
// POSIX path helpers (remote paths are always POSIX)
// ---------------------------------------------------------------------------

/** Join two POSIX path segments, collapsing duplicate slashes. */
export function posixJoin(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const base = a.endsWith("/") ? a.slice(0, -1) : a;
  const tail = b.startsWith("/") ? b.slice(1) : b;
  return `${base}/${tail}`;
}

/** Normalize a POSIX path: collapse `//`, resolve `.` and `..`. */
export function posixNormalize(path: string): string {
  const parts = path.split("/");
  const out: string[] = [];
  const absolute = path.startsWith("/");
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push(part);
    } else {
      out.push(part);
    }
  }
  const result = out.join("/");
  return absolute ? `/${result}` : result || ".";
}

/** Last segment of a POSIX path. */
export function posixBasename(path: string): string {
  const normalized = posixNormalize(path);
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? normalized : normalized.slice(slash + 1);
}

/** Parent directory of a POSIX path; `"/"` for root-level entries. */
export function posixParentDir(path: string): string {
  const normalized = posixNormalize(path);
  const slash = normalized.lastIndexOf("/");
  if (slash <= 0) return "/";
  return normalized.slice(0, slash);
}
