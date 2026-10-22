/**
 * Internationalisation entry point (M-10).
 *
 * `useI18n()` for components, `t()` / `tp()` for non-React modules, and
 * `localizeError()` for errors coming from Rust.
 */
import { getLocale } from "./locale";
import { localizeRustMessage } from "./rust";

export * from "./messages";
export * from "./locale";
export { localizeRustMessage } from "./rust";

/** Normalise anything thrown, then translate Rust's Chinese messages if needed. */
export function localizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return localizeRustMessage(message, getLocale());
}

/** Error message helper keeping the original `Error` elsewhere. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
