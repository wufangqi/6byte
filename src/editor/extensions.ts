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
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
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

/** Chinese labels for the CodeMirror search panel (T16). */
const chinesePhrases = EditorState.phrases.of({
  Find: "查找",
  Replace: "替换",
  next: "下一个",
  previous: "上一个",
  all: "全部选中",
  replace: "替换",
  "replace all": "全部替换",
  close: "关闭",
  "match case": "区分大小写",
  regexp: "正则",
  "by word": "全词匹配",
  "current match": "当前匹配",
  "on line": "行",
  go: "跳转",
  "Go to line": "跳转到行",
  "replaced match on line $": "已替换第 $ 行的匹配",
  "replaced $ matches": "已替换 $ 处匹配",
});

function languageFor(filename: string): Extension {
  if (/\.(md|markdown|mdx)$/i.test(filename)) return markdown();
  // TODO(M2): add json/yaml/csv support via @codemirror/legacy-modes or lang-data.
  return [];
}

export interface ExtensionOptions {
  /** L1 large files (5–20 MB) drop folding/bracket/selection decorations to stay responsive. */
  simplified?: boolean;
  /** Called on every document change (O(1)); used by the markdown preview. */
  onDocChanged?: () => void;
  /**
   * Saves a pasted image and returns the Markdown snippet to insert, or `null`
   * to leave the paste alone. Provided by the app (needs the document directory).
   */
  onPasteImage?: (file: File) => Promise<string | null>;
}

export function buildExtensions(
  filename: string,
  onStats: (stats: { lines: number; chars: number }) => void,
  options: ExtensionOptions = {}
): Extension[] {
  const simplified = options.simplified ?? false;

  const syntax: Extension[] = simplified
    ? []
    : [
        foldGutter(),
        bracketMatching(),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      ];

  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    ...syntax,
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    highlightActiveLine(),
    rectangularSelection(),
    crosshairCursor(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    chinesePhrases,
    languageFor(filename),
    editorTheme,
    EditorView.domEventHandlers({
      paste: (event, view) => {
        const handler = options.onPasteImage;
        if (!handler) return false;
        const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
          file.type.startsWith("image/")
        );
        if (files.length === 0) return false;

        event.preventDefault();
        void (async () => {
          for (const file of files) {
            try {
              const snippet = await handler(file);
              if (snippet) view.dispatch(view.state.replaceSelection(snippet));
            } catch {
              /* the app surfaces errors through the banner */
            }
          }
        })();
        return true;
      },
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        // O(1) statistics only: the full text never enters React state per keystroke.
        onStats({
          lines: update.state.doc.lines,
          chars: update.state.doc.length,
        });
        options.onDocChanged?.();
      }
    }),
  ];
}
