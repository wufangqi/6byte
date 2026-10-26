import { samePath } from "../lib/paths";

/** Another tab already owns this path, so Save As must not open a second copy. */
export function duplicateTab<T extends { id: string; path: string | null }>(
  tabs: readonly T[],
  tabId: string,
  path: string
): T | null {
  return (
    tabs.find((tab) => tab.id !== tabId && tab.path !== null && samePath(tab.path, path)) ?? null
  );
}

/** Disk stat differs from the copy this tab was opened or saved with. */
export function statConflicts(
  opened: { mtimeMs: number; size: number },
  disk: { mtimeMs: number; size: number }
): boolean {
  return disk.mtimeMs !== opened.mtimeMs || disk.size !== opened.size;
}

/** The watcher echoed our own save. Large files have no size to compare. */
export function isWatcherEcho(
  tab: { mode: string; mtimeMs: number; size: number },
  event: { mtimeMs: number; size: number }
): boolean {
  return event.mtimeMs === tab.mtimeMs && (tab.mode === "large" || event.size === tab.size);
}
