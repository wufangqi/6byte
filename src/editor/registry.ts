import type { EditorView } from "@codemirror/view";

/**
 * Registry of live EditorViews, one per open tab.
 *
 * The store only keeps a snapshot of each buffer; the authoritative text of the
 * active tab lives here and is read on save, so keystrokes never copy the whole
 * document through React state.
 */
const views = new Map<string, EditorView>();

export function registerView(tabId: string, view: EditorView): void {
  views.set(tabId, view);
}

export function unregisterView(tabId: string, view: EditorView): void {
  if (views.get(tabId) === view) views.delete(tabId);
}

/** Live buffer text of a mounted tab, or `null` when the tab is not mounted. */
export function getDocText(tabId: string): string | null {
  const view = views.get(tabId);
  return view ? view.state.doc.toString() : null;
}

type DocListener = () => void;
const docListeners = new Map<string, Set<DocListener>>();

/** Signal that a tab's buffer changed (O(1); listeners read the text themselves). */
export function notifyDocChanged(tabId: string): void {
  const listeners = docListeners.get(tabId);
  if (!listeners) return;
  for (const listener of listeners) listener();
}

/** Subscribe to buffer changes of a mounted tab. Returns an unsubscribe function. */
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

/** Scroll container of a mounted tab (used for preview scroll sync). */
export function getScrollElement(tabId: string): HTMLElement | null {
  return views.get(tabId)?.scrollDOM ?? null;
}

/**
 * Move the caret to a 1-based line and scroll it into view. Returns `false` when
 * the tab is not mounted yet (the caller can retry after the editor mounts).
 */
export function revealLine(tabId: string, line: number): boolean {
  const view = views.get(tabId);
  if (!view) return false;
  const target = Math.max(1, Math.min(line, view.state.doc.lines));
  const info = view.state.doc.line(target);
  view.dispatch({ selection: { anchor: info.from }, scrollIntoView: true });
  view.focus();
  return true;
}
