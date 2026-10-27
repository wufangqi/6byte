/** Width limits for the docked AI review panel, in pixels. */
export const AI_PANEL_DEFAULT_WIDTH = 420;
export const AI_PANEL_MIN_WIDTH = 300;
export const AI_PANEL_MAX_WIDTH = 640;
export const AI_PANEL_MIN_EDITOR_WIDTH = 320;
export const AI_PANEL_KEYBOARD_STEP = 24;

/**
 * Keep room for the document while resizing the dock. `workspaceWidth` is the
 * width available after the file tree, if any, has been accounted for.
 */
export function clampAiPanelWidth(
  value: number,
  workspaceWidth = Number.POSITIVE_INFINITY
): number {
  if (!Number.isFinite(value)) return AI_PANEL_DEFAULT_WIDTH;

  const maximumForWorkspace = Number.isFinite(workspaceWidth)
    ? Math.max(AI_PANEL_MIN_WIDTH, workspaceWidth - AI_PANEL_MIN_EDITOR_WIDTH)
    : AI_PANEL_MAX_WIDTH;
  const maximum = Math.min(AI_PANEL_MAX_WIDTH, maximumForWorkspace);

  return Math.min(maximum, Math.max(AI_PANEL_MIN_WIDTH, Math.round(value)));
}
