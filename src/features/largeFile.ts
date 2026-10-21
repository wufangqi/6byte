/** Geometry + fetch policy for the read-only large-file viewer. */

/** Fixed row height in px; keep in sync with `.viewer__line` in styles.css. */
export const LINE_HEIGHT = 20;

/** How many lines a single `read_range` call asks for. */
export const WINDOW_LINES = 400;

/** Extra lines kept above/below the viewport before refetching. */
export const OVERSCAN = 80;

/** Rough number of rows visible in the scroller (800 px tall window). */
export const VISIBLE_LINES = 48;

/** First line index currently at the top of the scroller. */
export function firstVisibleLine(scrollTop: number): number {
  return Math.max(0, Math.floor(scrollTop / LINE_HEIGHT));
}

/**
 * The window start to load so that `scrollTop` is covered with overscan.
 * Keeps the requested window aligned to `WINDOW_LINES`-sized chunks so small
 * scrolls do not trigger a new IPC round trip.
 */
export function windowStartFor(scrollTop: number, totalLines: number): number {
  const first = firstVisibleLine(scrollTop);
  const half = Math.floor(WINDOW_LINES / 2);
  const maxStart = Math.max(0, totalLines - WINDOW_LINES);
  return Math.min(maxStart, Math.max(0, first - half));
}

/** True when the loaded window no longer covers the viewport (plus overscan). */
export function needsFetch(
  scrollTop: number,
  windowStart: number,
  loadedCount: number,
  totalLines: number
): boolean {
  if (totalLines === 0) return false;
  const first = firstVisibleLine(scrollTop);
  const last = first + VISIBLE_LINES;
  return first < windowStart - OVERSCAN || last > windowStart + loadedCount + OVERSCAN;
}
