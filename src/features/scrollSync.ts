/** Fraction-based scroll sync between the editor and the markdown preview. */

export interface ScrollMetrics {
  top: number;
  height: number;
  client: number;
}

/** Position of the scroll thumb, 0–1; handles content shorter than the viewport. */
export function scrollFraction(metrics: ScrollMetrics): number {
  const range = metrics.height - metrics.client;
  if (range <= 0) return 0;
  return Math.min(1, Math.max(0, metrics.top / range));
}

/** Scroll offset for a 0–1 fraction, clamped to the target's scrollable range. */
export function topForFraction(fraction: number, height: number, client: number): number {
  const range = Math.max(0, height - client);
  return Math.min(range, Math.max(0, fraction * range));
}
