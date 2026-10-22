/** Geometry for the draggable editor/preview split (percent of the container). */

export const MIN_SPLIT_PERCENT = 20;
export const MAX_SPLIT_PERCENT = 85;
export const DEFAULT_SPLIT_PERCENT = 50;

/** Clamp a pointer position (viewport x) to a split percentage inside the container. */
export function clampSplitPercent(
  clientX: number,
  containerLeft: number,
  containerWidth: number
): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return DEFAULT_SPLIT_PERCENT;
  const percent = ((clientX - containerLeft) / containerWidth) * 100;
  return Math.min(MAX_SPLIT_PERCENT, Math.max(MIN_SPLIT_PERCENT, Math.round(percent)));
}

/** Keyboard step for the separator (arrow keys), in percent. */
export const SPLIT_KEYBOARD_STEP = 3;

export function adjustSplitPercent(current: number, delta: number): number {
  return Math.min(MAX_SPLIT_PERCENT, Math.max(MIN_SPLIT_PERCENT, Math.round(current + delta)));
}

/** Validate a persisted value; falls back to the default. */
export function normalizeSplitPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPLIT_PERCENT;
  return Math.min(MAX_SPLIT_PERCENT, Math.max(MIN_SPLIT_PERCENT, Math.round(value)));
}
