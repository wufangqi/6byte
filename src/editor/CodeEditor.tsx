import { useEffect, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { buildExtensions } from "./extensions";

interface Props {
  content: string;
  filename: string;
  onChange: (doc: string) => void;
}

/**
 * Thin React wrapper around CodeMirror 6.
 *
 * The parent is expected to remount this component per tab (React `key={tab.id}`),
 * which resets undo history per tab. Switching back preserves the tab content from
 * the store but not its undo stack — acceptable for M0, tracked as a TODO.
 */
export default function CodeEditor({ content, filename, onChange }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const extensions: Extension[] = buildExtensions(filename, (doc) =>
      onChangeRef.current(doc)
    );
    const view = new EditorView({
      state: EditorState.create({ doc: content, extensions }),
      parent: host,
    });
    view.focus();

    return () => {
      view.destroy();
    };
    // Mount only: content changes are pushed through the store, never re-injected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="editor-host" ref={hostRef} />;
}