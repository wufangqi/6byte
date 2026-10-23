import { useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import type { Tab } from "../stores/workspace";
import { useWorkspace } from "../stores/workspace";
import {
  ensureDocState,
  getDocScrollTop,
  reconfigureDocStates,
  saveDocState,
  type DocStateInit,
} from "./docStates";
import { attachView, detachView, notifyDocChanged, setActiveTab } from "./registry";
import { editorChrome, localeCompartment, searchPhrases, themeCompartment } from "./extensions";
import { getLocale, subscribeLocale } from "../i18n/locale";
import { getResolvedTheme, subscribeTheme } from "../features/theme";

interface Props {
  tab: Tab;
  /** L1 files (5–20 MB) turn off folding/bracket/selection decorations. */
  simplified?: boolean;
  /** Saves a pasted image, returning the Markdown snippet to insert. */
  onPasteImage?: (file: File) => Promise<string | null>;
}

/**
 * The single CodeMirror view shared by every tab (M-06).
 *
 * Each tab keeps its own `EditorState` in `docStates`; switching tabs swaps the
 * state into this one view, so undo history survives tab switches and preview
 * toggles instead of being reset by a remount.
 */
export default function EditorHost({ tab, simplified, onPasteImage }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const pasteRef = useRef(onPasteImage);
  const simplifiedRef = useRef(simplified);

  // Keep the latest props without remounting the view.
  useEffect(() => {
    pasteRef.current = onPasteImage;
    simplifiedRef.current = simplified;
  });

  const initFor = (target: Tab): DocStateInit => ({
    content: target.content,
    filename: target.name,
    version: target.version,
    simplified: simplifiedRef.current,
    onStats: (stats) => {
      const store = useWorkspace.getState();
      if (stats.preview) store.noteDocStats(target.id, stats);
      else store.markEdited(target.id, stats);
    },
    onDocChanged: () => notifyDocChanged(target.id),
    onStateChanged: (state) => saveDocState(target.id, state),
    onPasteImage: pasteRef.current ? (file) => pasteRef.current!(file) : undefined,
  });

  // Mount once: create the view and bind it to the first tab. Swapping documents
  // is done by the effect below, never by a remount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      state: ensureDocState(tab.id, initFor(tab)),
      parent: host,
    });
    viewRef.current = view;
    activeIdRef.current = tab.id;
    attachView(tab.id, view);
    requestAnimationFrame(() => {
      view.scrollDOM.scrollTop = getDocScrollTop(tab.id);
      view.focus();
    });

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
      unsubscribeTheme();
      unsubscribeLocale();
      const current = activeIdRef.current;
      if (current) saveDocState(current, view.state, view.scrollDOM.scrollTop);
      detachView(view);
      viewRef.current = null;
      view.destroy();
    };
    // Mount only; the active document is handled by the swap effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap the cached state of the active tab into the shared view. The previous
  // state (with its undo history) is stored back first.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previous = activeIdRef.current;
    if (previous && previous !== tab.id) {
      saveDocState(previous, view.state, view.scrollDOM.scrollTop);
    }
    const state = ensureDocState(tab.id, initFor(tab));
    if (view.state !== state) {
      view.setState(state);
      const scrollTop = getDocScrollTop(tab.id);
      requestAnimationFrame(() => {
        view.scrollDOM.scrollTop = scrollTop;
      });
    }
    activeIdRef.current = tab.id;
    setActiveTab(tab.id);
    view.focus();
    // `tab.version` changes when the buffer is reloaded from disk, which must
    // rebuild the state (and intentionally drop that tab's history). The rest of
    // the tab object is not a dependency: only its id and version matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.version]);

  return <div className="editor-host" ref={hostRef} />;
}
