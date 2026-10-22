import { useEffect, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { buildExtensions, editorChrome, themeCompartment } from "./extensions";
import { getResolvedTheme, subscribeTheme } from "../features/theme";
import { registerView, unregisterView, notifyDocChanged } from "./registry";

interface Props {
  tabId: string;
  content: string;
  filename: string;
  /** Bumped when the buffer is reloaded from disk; guards the unmount flush. */
  version: number;
  /** L1 files (5–20 MB) turn off folding/bracket/selection decorations. */
  simplified?: boolean;
  /** O(1) statistics pushed on every document change (never the full text). */
  onStats: (tabId: string, stats: { lines: number; chars: number }) => void;
  /** Hands the live buffer back to the store when this editor unmounts. */
  onFlush: (tabId: string, content: string, version: number) => void;
  /** Saves a pasted image, returning the Markdown snippet to insert. */
  onPasteImage?: (file: File) => Promise<string | null>;
}

/**
 * Thin React wrapper around CodeMirror 6.
 *
 * The parent remounts this component per tab (React `key`), which resets undo
 * history per tab. The buffer is flushed to the store on unmount so switching
 * tabs never drops edits, and the live text is read from the view when saving.
 */
export default function CodeEditor({
  tabId,
  content,
  filename,
  version,
  simplified,
  onStats,
  onFlush,
  onPasteImage,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onStatsRef = useRef(onStats);
  const onFlushRef = useRef(onFlush);
  const onPasteImageRef = useRef(onPasteImage);

  // Keep the latest callbacks without remounting the editor.
  useEffect(() => {
    onStatsRef.current = onStats;
    onFlushRef.current = onFlush;
    onPasteImageRef.current = onPasteImage;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const extensions: Extension[] = buildExtensions(
      filename,
      (stats) => onStatsRef.current(tabId, stats),
      {
        simplified,
        onDocChanged: () => notifyDocChanged(tabId),
        onPasteImage: onPasteImageRef.current
          ? (file) =>
              onPasteImageRef.current ? onPasteImageRef.current(file) : Promise.resolve(null)
          : undefined,
      }
    );
    const view = new EditorView({
      state: EditorState.create({ doc: content, extensions }),
      parent: host,
    });
    registerView(tabId, view);
    view.focus();
    const unsubscribeTheme = subscribeTheme(() => {
      view.dispatch({
        effects: themeCompartment.reconfigure(editorChrome(getResolvedTheme())),
      });
    });

    return () => {
      unsubscribeTheme();
      // Preserve edits made in this tab before the view is destroyed. The version
      // guard keeps a stale view from overwriting a freshly reloaded buffer.
      onFlushRef.current(tabId, view.state.doc.toString(), version);
      unregisterView(tabId, view);
      view.destroy();
    };
    // Mount only: disk reloads remount the component via `version` in the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="editor-host" ref={hostRef} />;
}
