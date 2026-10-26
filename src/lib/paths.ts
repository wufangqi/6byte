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
