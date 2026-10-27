import type { EditorView } from "@codemirror/view";
import { getDocText as cachedDocText } from "./docStates";

/**
 * The view currently on screen in this window.
 *
 * Each window has its own module instance. Inactive tabs keep an `EditorState`
 * in `docStates` (undo included) and do not need a second view.
 */
let view: EditorView | null = null;
let activeTabId: string | null = null;

const readyListeners = new Set<(tabId: string) => void>();

function emitReady(tabId: string): void {
  for (const listener of [...readyListeners]) listener(tabId);
}

/** Fires after the shared view is showing `tabId`. */
export function subscribeEditorReady(listener: (tabId: string) => void): () => void {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

/** Bind the shared view to the tab whose state it currently shows. */
export function attachView(tabId: string, next: EditorView): void {
  view = next;
  activeTabId = tabId;
}

export function detachView(next: EditorView): void {
  if (view !== next) return;
  view = null;
  activeTabId = null;
}

/** Update the tab association after the view swaps to another document. */
export function setActiveTab(tabId: string): void {
  activeTabId = tabId;
}

/** The view is showing `tabId` and its saved scroll position has been restored. */
export function settleEditor(tabId: string): void {
  if (activeTabId === tabId) emitReady(tabId);
}

/** Live buffer text of any cached tab, or `null` when the tab has never been mounted. */
export function getDocText(tabId: string): string | null {
  return cachedDocText(tabId);
}

/** Live text, or the open/save snapshot when this tab has no editor state yet. */
export function readBuffer(tabId: string, snapshot: string): string {
  return cachedDocText(tabId) ?? snapshot;
}

/**
 * Text of the main selection in the tab currently shown.
 * `null` when that tab is not on screen, `""` when the caret has no range.
 */
export function getSelectionText(tabId: string): string | null {
  if (!view || activeTabId !== tabId) return null;
  const { from, to } = view.state.selection.main;
  if (from === to) return "";
  return view.state.sliceDoc(from, to);
}

/** The shared view while it is showing `tabId`. */
export function getEditorView(tabId: string): EditorView | null {
  if (!view || activeTabId !== tabId) return null;
  return view;
}

/** Main selection span of the tab on screen, or `null` when the caret is collapsed. */
export function getSelectionSpan(tabId: string): { from: number; to: number; text: string } | null {
  const editor = getEditorView(tabId);
  if (!editor) return null;
  const { from, to } = editor.state.selection.main;
  if (from === to) return null;
  return { from, to, text: editor.state.sliceDoc(from, to) };
}

/** Insert text at the visible tab's main caret, replacing its current selection. */
export function insertTextAtSelection(tabId: string, text: string): boolean {
  const editor = getEditorView(tabId);
  if (!editor || !text) return false;
  const { from, to } = editor.state.selection.main;
  const anchor = from + text.length;
  editor.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor },
    scrollIntoView: true,
    userEvent: "input.answer",
  });
  editor.focus();
  return true;
}

type DocListener = () => void;
const docListeners = new Map<string, Set<DocListener>>();

/** Signal that a tab's buffer changed (O(1); listeners read the text themselves). */
export function notifyDocChanged(tabId: string): void {
  const listeners = docListeners.get(tabId);
  if (!listeners) return;
  for (const listener of listeners) listener();
}

/** Subscribe to buffer changes of a tab. Returns an unsubscribe function. */
export function subscribeDocChanges(tabId: string, listener: DocListener): () => void {
  let listeners = docListeners.get(tabId);
  if (!listeners) {
    listeners = new Set();
    docListeners.set(tabId, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = docListeners.get(tabId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) docListeners.delete(tabId);
  };
}

/** Scroll container of the tab currently shown by the shared view. */
export function getScrollElement(tabId: string): HTMLElement | null {
  if (!view || activeTabId !== tabId) return null;
  return view.scrollDOM;
}

/**
 * Move the caret to a 1-based line and scroll it into view. Returns `false` when
 * the tab is not the one currently shown (the caller can retry after a swap).
 */
export function revealLine(tabId: string, line: number): boolean {
  if (!view || activeTabId !== tabId) return false;
  const target = Math.max(1, Math.min(line, view.state.doc.lines));
  const info = view.state.doc.line(target);
  view.dispatch({ selection: { anchor: info.from }, scrollIntoView: true });
  view.focus();
  return true;
}

/** Reveal once this window's view has settled on the tab. No timer. */
export function revealLineWhenReady(tabId: string, line: number, onShown: () => void): () => void {
  if (revealLine(tabId, line)) {
    onShown();
    return () => {};
  }
  let stop = () => {};
  stop = subscribeEditorReady((id) => {
    if (id !== tabId || !revealLine(tabId, line)) return;
    stop();
    onShown();
  });
  return stop;
}
