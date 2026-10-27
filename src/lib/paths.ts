/** Path comparison that tolerates Windows separators and casing. */

/** Drop the Windows verbatim prefix so `\\?\C:\a` matches `C:\a`. */
function withoutVerbatim(value: string): string {
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}

export function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  const windowsStyle = a.includes("\\") || b.includes("\\");
  if (!windowsStyle) return false;
  const normalize = (value: string) => withoutVerbatim(value.replace(/\//g, "\\")).toLowerCase();
  return normalize(a) === normalize(b);
}

/** Last path segment, used for tab titles and recent-file entries. */
export function fileName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Folder that contains `path`, in the same separator style; `null` at the root. */
export function parentDir(path: string): string | null {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (slash <= 0) return null;
  return path.slice(0, slash);
}

/** Join a folder and a file name, keeping the folder's separator style. */
export function joinPath(dir: string, name: string): string {
  const separator = dir.includes("\\") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${separator}${name}`;
}
