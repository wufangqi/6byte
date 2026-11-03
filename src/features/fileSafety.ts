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

/**
 * A clean file already on disk has nothing to write. Saving it would change
 * the mtime, and the watcher would reload the buffer, sending the caret to
 * the first line.
 */
export function saveTouchesDisk(
  tab: { path: string | null; dirty: boolean; meta: { lossy: boolean; mixedEol: boolean } },
  saveAs: boolean
): boolean {
  if (saveAs || !tab.path) return true;
  return tab.dirty || tab.meta.lossy || tab.meta.mixedEol;
}

/** The watcher echoed our own save. Large files have no size to compare. */
export function isWatcherEcho(
  tab: { mode: string; mtimeMs: number; size: number },
  event: { mtimeMs: number; size: number }
): boolean {
  return event.mtimeMs === tab.mtimeMs && (tab.mode === "large" || event.size === tab.size);
}

type OwnWrite = { path: string; stat: { size: number; mtimeMs: number } | null };

const ownWrites: OwnWrite[] = [];

/** Mark a path whose next watcher event comes from a save this window started. */
export function beginOwnWrite(path: string): void {
  ownWrites.push({ path, stat: null });
}

/** Record the stat the save just wrote. An echo that already arrived left no pending mark. */
export function finishOwnWrite(path: string, stat: { size: number; mtimeMs: number }): void {
  const pending = ownWrites.find((item) => item.stat === null && samePath(item.path, path));
  if (pending) pending.stat = stat;
  else ownWrites.push({ path, stat });
}

/** Drop a save that failed before anything was written. */
export function cancelOwnWrite(path: string): void {
  const index = ownWrites.findIndex((item) => item.stat === null && samePath(item.path, path));
  if (index >= 0) ownWrites.splice(index, 1);
}

/**
 * True when `event` is the echo of a save started here. An event that arrives
 * before the new stat is stored is still ours: the tab is not dirty yet, and
 * reloading it would rebuild the editor at the first line.
 */
export function isOwnWriteEvent(path: string, event: { size: number; mtimeMs: number }): boolean {
  const done = ownWrites.findIndex(
    (item) =>
      item.stat !== null &&
      samePath(item.path, path) &&
      item.stat.size === event.size &&
      item.stat.mtimeMs === event.mtimeMs
  );
  if (done >= 0) {
    ownWrites.splice(done, 1);
    return true;
  }
  const pending = ownWrites.findIndex((item) => item.stat === null && samePath(item.path, path));
  if (pending >= 0) {
    ownWrites.splice(pending, 1);
    return true;
  }
  return false;
}
