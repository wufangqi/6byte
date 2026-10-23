/** Path comparison that tolerates Windows separators and casing. */

export function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  const windowsStyle = a.includes("\\") || b.includes("\\");
  if (!windowsStyle) return false;
  return a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
}

/** Last path segment, used for tab titles and recent-file entries. */
export function fileName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
