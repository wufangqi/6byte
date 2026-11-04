import { useEffect, useLayoutEffect, useRef } from "react";
import type { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Tab } from "../stores/workspace";
import { useWorkspace } from "../stores/workspace";
import {
  ensureDocState,
  getDocScrollAnchor,
  getDocScrollTop,
  getDocState,
  readScrollTop,
  reconfigureDocStates,
  saveDocState,
  selectionJumpedHome,
  type DocStateInit,
} from "./docStates";
import { suppressViewPersistence } from "./viewLifetime";
import {
  attachView,
  detachView,
  notifyDocChanged,
  notifySelectionChanged,
  setActiveTab,
  settleEditor,
} from "./registry";
import { editorChrome, localeCompartment, searchPhrases, themeCompartment } from "./extensions";
import { getLocale, subscribeLocale } from "../i18n/locale";
import { getResolvedTheme, subscribeTheme } from "../features/theme";

interface PlaceRefs {
  gen: { current: number };
  placing: { current: boolean };
  scroll: { current: number };
  view: { current: EditorView | null };
  activeId: { current: string | null };
}

/** Document position at the top of the viewport, or 0 at the start of the file. */
function anchorAt(view: EditorView, scrollTop: number): number {
  if (scrollTop <= 0) return 0;
  try {
    return view.lineBlockAtHeight(scrollTop).from;
  } catch {
    return 0;
  }
}

function topShowsAnchor(view: EditorView, anchor: number): boolean {
  if (view.scrollDOM.clientHeight <= 0) return false;
  if (anchor <= 0) return view.scrollDOM.scrollTop <= 1;
  try {
    const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop + 1);
    return anchor >= block.from && anchor < block.to;
  } catch {
    return false;
  }
}

/** Put the caret and scroll back. Retries until the document is tall enough. */
function placeTab(
  view: EditorView,
  tabId: string,
  selection: EditorSelection,
  refs: PlaceRefs
): void {
  const gen = ++refs.gen.current;
  const desired = getDocScrollTop(tabId);
  const anchor = getDocScrollAnchor(tabId);
  const doc = view.state.doc;
  refs.scroll.current = desired;
  refs.placing.current = true;
  let frames = 0;

  const finish = (persist: boolean) => {
    if (gen !== refs.gen.current) return;
    refs.placing.current = false;
    if (
      persist &&
      view.scrollDOM.isConnected &&
      view.scrollDOM.clientHeight > 0 &&
      (anchor <= 0 || topShowsAnchor(view, anchor))
    ) {
      const top = view.scrollDOM.scrollTop;
      refs.scroll.current = top;
      saveDocState(tabId, view.state, top, anchorAt(view, top));
    }
    settleEditor(tabId);
  };

  const step = () => {
    if (gen !== refs.gen.current || refs.view.current !== view || refs.activeId.current !== tabId) {
      if (gen === refs.gen.current) refs.placing.current = false;
      return;
    }
    if (view.state.doc.eq(doc) && selectionJumpedHome(view.state.selection, selection)) {
      view.dispatch({ selection, scrollIntoView: false });
    }
    if (anchor > 0 && !topShowsAnchor(view, anchor)) {
      view.dispatch({
        effects: EditorView.scrollIntoView(anchor, { y: "start", yMargin: 0 }),
      });
    } else if (view.scrollDOM.clientHeight > 0) {
      view.scrollDOM.scrollTop = desired;
    }
    frames += 1;
    const max = Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight);
    const heightReady = desired <= max + 1;
    const placed = anchor > 0 ? topShowsAnchor(view, anchor) : heightReady;
    if (placed || frames >= 30) {
      finish(placed);
      return;
    }
    view.requestMeasure();
    requestAnimationFrame(step);
  };

  step();
}

interface Props {
  tab: Tab;
  /** L1 files (5–20 MB) turn off folding/bracket/selection decorations. */
  simplified?: boolean;
  /** Saves a pasted image, returning the Markdown snippet to insert. */
  onPasteImage?: (file: File) => Promise<string | null>;
  /** Markdown preview-only keeps the view mounted but must not take the caret. */
  visible?: boolean;
}

/**
 * The single CodeMirror view shared by every tab (M-06).
 *
 * Each tab keeps its own `EditorState` in `docStates`; switching tabs swaps the
 * state into this one view, so undo history survives tab switches and preview
 * toggles instead of being reset by a remount.
 */
export default function EditorHost({ tab, simplified, onPasteImage, visible = true }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  /** Last scroll offset read while the editor was actually on screen. */
  const scrollRef = useRef(0);
  /** Ignore scroll events caused by restoring a tab, so they cannot save 0. */
  const placingRef = useRef(false);
  const placeGen = useRef(0);
  const pasteRef = useRef(onPasteImage);
  const simplifiedRef = useRef(simplified);
  const visibleRef = useRef(visible);

  // Keep the latest props without remounting the view.
  useEffect(() => {
    pasteRef.current = onPasteImage;
    simplifiedRef.current = simplified;
    visibleRef.current = visible;
  });

  const initFor = (target: Tab): DocStateInit => ({
    content: target.content,
    filename: target.name,
    version: target.version,
    simplified: simplifiedRef.current,
    onStats: (stats) => {
      useWorkspace.getState().markEdited(target.id, stats);
    },
    onDocChanged: (edits) => notifyDocChanged(target.id, edits),
    onSelectionChanged: () => notifySelectionChanged(target.id),
    onStateChanged: (state) => saveDocState(target.id, state),
    onPasteImage: pasteRef.current ? (file) => pasteRef.current!(file) : undefined,
    editorLive: () => {
      const scroller = scrollerRef.current;
      if (!scroller) return true;
      return scroller.isConnected && scroller.clientHeight > 0;
    },
  });

  const placeRefs = (): PlaceRefs => ({
    gen: placeGen,
    placing: placingRef,
    scroll: scrollRef,
    view: viewRef,
    activeId: activeIdRef,
  });

  // Mount once: create the view and bind it to the first tab. Swapping documents
  // is done by the effect below, never by a remount. Layout, not passive, so the
  // view exists before the swap effect in the same commit.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      state: ensureDocState(tab.id, initFor(tab)),
      parent: host,
    });
    viewRef.current = view;
    scrollerRef.current = view.scrollDOM;
    activeIdRef.current = tab.id;
    attachView(tab.id, view);

    const onScroll = () => {
      if (placingRef.current) return;
      const id = activeIdRef.current;
      if (!id) return;
      const top = readScrollTop(view.scrollDOM, scrollRef.current);
      if (!view.scrollDOM.isConnected || view.scrollDOM.clientHeight <= 0) return;
      scrollRef.current = top;
      saveDocState(id, view.state, top, anchorAt(view, top));
    };
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });

    const unsubscribeTheme = subscribeTheme(() => {
      view.dispatch({ effects: themeCompartment.reconfigure(editorChrome(getResolvedTheme())) });
      reconfigureDocStates(activeIdRef.current);
    });
    const unsubscribeLocale = subscribeLocale(() => {
      view.dispatch({
        effects: localeCompartment.reconfigure(searchPhrases(getLocale())),
      });
      reconfigureDocStates(activeIdRef.current);
    });

    return () => {
      placeGen.current += 1;
      placingRef.current = false;
      unsubscribeTheme();
      unsubscribeLocale();
      view.scrollDOM.removeEventListener("scroll", onScroll);
      const current = activeIdRef.current;
      if (current) {
        // The node is already detached here, so scrollTop is 0 and the caret
        // may have collapsed. Keep the last on-screen snapshot instead.
        const laidOut = view.scrollDOM.isConnected && view.scrollDOM.clientHeight > 0;
        const top = readScrollTop(view.scrollDOM, scrollRef.current);
        const state = laidOut ? view.state : (getDocState(current) ?? view.state);
        saveDocState(current, state, top, laidOut ? anchorAt(view, top) : undefined);
      }
      // Destroying the DOM makes CodeMirror treat the visible lines as the
      // whole file. Ignore that transaction, and stop watching mutations first.
      suppressViewPersistence(view);
      (view as unknown as { observer?: { stop: () => void } }).observer?.stop();
      scrollerRef.current = null;
      detachView(view);
      viewRef.current = null;
      view.destroy();
    };
    // Mount only; the active document is handled by the swap effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap the cached state of the active tab into the shared view. The previous
  // state (with its undo history and scroll) is stored back first.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previous = activeIdRef.current;
    placingRef.current = true;
    if (previous && previous !== tab.id) {
      const laidOut = view.scrollDOM.isConnected && view.scrollDOM.clientHeight > 0;
      const top = readScrollTop(view.scrollDOM, scrollRef.current);
      const state = laidOut ? view.state : (getDocState(previous) ?? view.state);
      saveDocState(previous, state, top, laidOut ? anchorAt(view, top) : undefined);
    }
    const state = ensureDocState(tab.id, initFor(tab));
    const selection = state.selection;
    if (view.state !== state) view.setState(state);
    activeIdRef.current = tab.id;
    setActiveTab(tab.id);
    scrollRef.current = getDocScrollTop(tab.id);
    if (visibleRef.current) view.focus();
    placeTab(view, tab.id, selection, placeRefs());
    // `tab.version` rebuilds the state after a reload. `tab.name` reconfigures
    // highlighting when Save As changes the extension, and keeps undo history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.version, tab.name]);

  // Drop focus while a preview covers the source. The editor stays laid out, so
  // its scroll and caret survive; put them back if a hide still collapsed them.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (!visible) {
      if (view.hasFocus) view.contentDOM.blur();
      return;
    }
    const id = activeIdRef.current;
    if (!id) return;
    view.requestMeasure();
    if (!view.hasFocus) view.focus();
    const remembered = getDocState(id)?.selection ?? view.state.selection;
    placeTab(view, id, remembered, placeRefs());
  }, [visible]);

  return <div className="editor-host" ref={hostRef} />;
}
