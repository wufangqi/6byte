/** http and https only. The preview must not hand javascript: or file: to the OS. */
export function isSafeHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].some((char) => char <= " " || char === "\u007f")) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
