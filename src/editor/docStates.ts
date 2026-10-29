import { EditorState } from "@codemirror/state";
import { getLocale } from "../i18n/locale";
import { getResolvedTheme } from "../features/theme";
import {
  buildExtensions,
  editorChrome,
  languageCompartment,
  languageExtensions,
  localeCompartment,
  searchPhrases,
  themeCompartment,
} from "./extensions";

/**
 * One `EditorState` per open text tab (M-06).
 *
 * Undo history lives inside the state, so keeping the state objects around lets
 * the single shared `EditorView` swap documents without losing history. A state
 * is only recreated when the store bumps the tab's `version` (reload from disk).
 * A new filename reconfigures highlighting and wrapping and keeps the history.
 */
export interface DocStateInit {
  content: string;
  filename: string;
  version: number;
  /** L1 files (5–20 MB) drop folding/bracket/selection decorations. */
  simplified?: boolean;
  onStats: (stats: { lines: number; chars: number }) => void;
  onDocChanged?: () => void;
  onStateChanged?: (state: EditorState) => void;
  onPasteImage?: (file: File) => Promise<string | null>;
}

interface DocEntry {
  state: EditorState;
  version: number;
  filename: string;
  scrollTop: number;
}

const entries = new Map<string, DocEntry>();

function createState(init: DocStateInit): EditorState {
  return EditorState.create({
    doc: init.content,
    extensions: buildExtensions(init.filename, init.onStats, {
      simplified: init.simplified,
      onDocChanged: init.onDocChanged,
      onStateChanged: init.onStateChanged,
      onPasteImage: init.onPasteImage,
    }),
  });
}

/**
 * State for `tabId`, reusing the cached one (with its undo history) when the
 * store version still matches. Callers swap the result into the shared view.
 */
function applyFilename(entry: DocEntry, filename: string): EditorState {
  if (entry.filename === filename) return entry.state;
  entry.filename = filename;
  entry.state = entry.state.update({
    effects: languageCompartment.reconfigure(languageExtensions(filename)),
  }).state;
  return entry.state;
}

export function ensureDocState(tabId: string, init: DocStateInit): EditorState {
  const existing = entries.get(tabId);
  if (existing && existing.version === init.version) return applyFilename(existing, init.filename);
  const state = createState(init);
  entries.set(tabId, {
    state,
    version: init.version,
    filename: init.filename,
    scrollTop: existing?.scrollTop ?? 0,
  });
  return state;
}

/** Persist the live state (and scroll offset) of the tab currently in the view. */
export function saveDocState(tabId: string, state: EditorState, scrollTop?: number): void {
  const entry = entries.get(tabId);
  if (!entry) return;
  entry.state = state;
  if (typeof scrollTop === "number") entry.scrollTop = scrollTop;
}

export function getDocState(tabId: string): EditorState | null {
  return entries.get(tabId)?.state ?? null;
}

/** Live text of any cached tab (active or not), or `null` when never opened. */
export function getDocText(tabId: string): string | null {
  const entry = entries.get(tabId);
  return entry ? entry.state.doc.toString() : null;
}

/** Scroll offset remembered for a tab (restored after swapping it into the view). */
export function getDocScrollTop(tabId: string): number {
  return entries.get(tabId)?.scrollTop ?? 0;
}

export function dropDocState(tabId: string): void {
  entries.delete(tabId);
}

/** Drop cached states of tabs that are no longer open. */
export function dropDocStatesExcept(keep: ReadonlySet<string>): void {
  for (const tabId of [...entries.keys()]) {
    if (!keep.has(tabId)) entries.delete(tabId);
  }
}

/**
 * Apply a theme / language change to every cached state. The active state is
 * updated by the view itself (it receives a reconfigure dispatch); the others
 * are updated in place so switching back keeps the right appearance.
 */
export function reconfigureDocStates(activeTabId: string | null): void {
  const effects = [
    themeCompartment.reconfigure(editorChrome(getResolvedTheme())),
    localeCompartment.reconfigure(searchPhrases(getLocale())),
  ];
  for (const [tabId, entry] of entries) {
    if (tabId === activeTabId) continue;
    entry.state = entry.state.update({ effects }).state;
  }
}

/** Number of cached document states (tests / diagnostics). */
export function docStateCount(): number {
  return entries.size;
}
