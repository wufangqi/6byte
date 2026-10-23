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
import { Compartment, EditorState, type Extension } from "@codemirror/state";
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
import { getLocale, type Locale } from "../i18n/locale";
import { translate } from "../i18n/messages";
import { getResolvedTheme, type ResolvedTheme } from "../features/theme";

/** Swapped when the appearance changes, without recreating the editor. */
export const themeCompartment = new Compartment();
/** Swapped when the UI language changes (CodeMirror's own panel strings). */
export const localeCompartment = new Compartment();

/** Editor chrome driven by the app's CSS variables. `dark` only flips CodeMirror's own panels. */
export function editorChrome(resolved: ResolvedTheme): Extension {
  return EditorView.theme(
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
    { dark: resolved === "dark" }
  );
}

/** CodeMirror search panel strings for one language (T16 / M-10). */
export function searchPhrases(locale: Locale): Extension {
  // CodeMirror uses `$` placeholders inside these two phrases.
  const replacedLine = translate(locale, "editor.search.replacedLine").replace("{line}", "$");
  const replacedCount = translate(locale, "editor.search.replacedCount").replace("{count}", "$");
  return EditorState.phrases.of({
    Find: translate(locale, "editor.search.find"),
    Replace: translate(locale, "editor.search.replace"),
    next: translate(locale, "editor.search.next"),
    previous: translate(locale, "editor.search.previous"),
    all: translate(locale, "editor.search.all"),
    replace: translate(locale, "editor.search.replaceOne"),
    "replace all": translate(locale, "editor.search.replaceAll"),
    close: translate(locale, "editor.search.close"),
    "match case": translate(locale, "editor.search.matchCase"),
    regexp: translate(locale, "editor.search.regexp"),
    "by word": translate(locale, "editor.search.byWord"),
    "current match": translate(locale, "editor.search.currentMatch"),
    "on line": translate(locale, "editor.search.onLine"),
    go: translate(locale, "editor.search.go"),
    "Go to line": translate(locale, "editor.search.goToLine"),
    "replaced match on line $": replacedLine,
    "replaced $ matches": replacedCount,
  });
}

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
   * Called with the new state on every update so the per-tab state cache stays
   * current (save/export/preview in inactive tabs read it).
   */
  onStateChanged?: (state: EditorState) => void;
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
    localeCompartment.of(searchPhrases(getLocale())),
    languageFor(filename),
    themeCompartment.of(editorChrome(getResolvedTheme())),
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
      // Keep the per-tab state cache fresh for saves, exports and inactive previews.
      options.onStateChanged?.(update.state);
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
