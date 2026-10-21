import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";

/** Dark editor theme driven by the app's CSS variables. */
const editorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      fontSize: "14px",
      backgroundColor: "var(--bg-editor)",
      color: "var(--fg)",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      lineHeight: "1.65",
      overflow: "auto",
    },
    ".cm-content": {
      padding: "14px 0",
      caretColor: "var(--accent)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--bg-editor)",
      color: "var(--fg-dim)",
      border: "none",
      paddingRight: "6px",
    },
    ".cm-activeLine": { backgroundColor: "var(--bg-active-line)" },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--bg-active-line)",
      color: "var(--fg)",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: "var(--selection) !important",
      },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--accent)",
      borderLeftWidth: "2px",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "transparent",
      border: "none",
      color: "var(--fg-dim)",
    },
    ".cm-searchMatch": { backgroundColor: "rgba(255, 200, 0, 0.25)" },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "rgba(255, 200, 0, 0.45)",
    },
  },
  { dark: true }
);

function languageFor(filename: string): Extension {
  if (/\.(md|markdown|mdx)$/i.test(filename)) return markdown();
  // TODO(M2): add json/yaml/csv support via @codemirror/legacy-modes or lang-data.
  return [];
}

export function buildExtensions(
  filename: string,
  onChange: (doc: string) => void
): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    rectangularSelection(),
    crosshairCursor(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    languageFor(filename),
    editorTheme,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString());
    }),
  ];
}