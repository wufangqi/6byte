const FIELD = "input, textarea, select, [contenteditable='true']";

/**
 * App-wide shortcuts stay out of dialogs and out of form fields.
 * CodeMirror's own find box lives inside `.cm-editor` and still reaches them.
 */
export function appShortcutBlocked(target: EventTarget | null, dialogOpen: boolean): boolean {
  if (dialogOpen) return true;
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  if (target.closest(".cm-editor")) return false;
  return target.closest(FIELD) !== null;
}

export function isAppShortcutBlocked(event: KeyboardEvent): boolean {
  return appShortcutBlocked(event.target, document.querySelector("[role='dialog']") !== null);
}
