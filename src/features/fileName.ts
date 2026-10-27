/**
 * Client-side mirror of the Rust rename validation.
 *
 * Rust is still authoritative (it owns the filesystem), but checking here keeps
 * the rename dialog open with an inline message instead of round-tripping.
 */

const INVALID_CHARACTERS = /[/\\:*?"<>|]/;
const MAX_NAME_LENGTH = 255;

export type FileNameProblem = "empty" | "dot" | "separator" | "control" | "tooLong" | null;

/** Why `name` cannot be used as a file name, or `null` when it is acceptable. */
export function fileNameProblem(name: string): FileNameProblem {
  const trimmed = name.trim();
  if (!trimmed) return "empty";
  if (trimmed === "." || trimmed === "..") return "dot";
  if (INVALID_CHARACTERS.test(trimmed)) return "separator";
  if ([...trimmed].some((character) => character.charCodeAt(0) < 0x20)) return "control";
  if (new TextEncoder().encode(trimmed).length > MAX_NAME_LENGTH) return "tooLong";
  return null;
}

/** Keep the existing extension when the user typed only a base name. */
export function withExtension(name: string, extension: string): string {
  const trimmed = name.trim();
  if (!extension.startsWith(".")) return trimmed;
  return /\.[^./\\]+$/.test(trimmed) ? trimmed : `${trimmed}${extension}`;
}

/** Extension of a file name, including the dot; empty when there is none. */
export function extensionOf(name: string): string {
  const match = /(\.[^./\\]+)$/.exec(name);
  return match ? match[1] : "";
}
