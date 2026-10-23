import { Annotation, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

/** Marks a streamed insert as not a real edit: it must not dirty the file. */
export const aiPreview = Annotation.define<true>();

interface InsertRange {
  from: number;
  to: number;
}

const setInlineInsert = StateEffect.define<InsertRange | null>();

function mark(range: InsertRange): DecorationSet {
  if (range.from >= range.to) return Decoration.none;
  return Decoration.set([Decoration.mark({ class: "cm-ai-inserted" }).range(range.from, range.to)]);
}

export const inlineInsertField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setInlineInsert)) continue;
      return effect.value ? mark(effect.value) : Decoration.none;
    }
    if (tr.docChanged) return Decoration.none;
    return deco.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function previewAnnotations() {
  return [Transaction.addToHistory.of(false), aiPreview.of(true)];
}

/**
 * Append `text` at `to` and highlight `[from, to + text.length)`.
 * `from` is the start of the insertion and does not move as text grows.
 */
export function paintInline(view: EditorView, from: number, to: number, text: string): number {
  const next = to + text.length;
  view.dispatch({
    changes: { from: to, to: to, insert: text },
    effects: setInlineInsert.of(next > from ? { from, to: next } : null),
    annotations: previewAnnotations(),
    selection: { anchor: next },
    scrollIntoView: true,
  });
  return next;
}

/** Delete the highlighted insert. The original selection stays. Not saved. */
export function cancelInline(view: EditorView, from: number, to: number): void {
  if (from < 0 || to > view.state.doc.length || from > to) return;
  view.dispatch({
    changes: from === to ? undefined : { from, to, insert: "" },
    effects: setInlineInsert.of(null),
    annotations: previewAnnotations(),
  });
}

/**
 * Drop the original selection and keep the inserted text.
 * One undo restores the document from before this accept. The file is not saved.
 */
export function acceptInline(
  view: EditorView,
  originalFrom: number,
  originalTo: number,
  insertFrom: number,
  insertTo: number
): boolean {
  if (insertFrom !== originalTo) return false;
  if (originalFrom < 0 || insertTo > view.state.doc.length || originalFrom > insertTo) return false;
  const inserted = view.state.sliceDoc(insertFrom, insertTo);
  view.dispatch({
    changes: insertFrom === insertTo ? undefined : { from: insertFrom, to: insertTo, insert: "" },
    effects: setInlineInsert.of(null),
    annotations: previewAnnotations(),
  });
  view.dispatch({
    changes: { from: originalFrom, to: originalTo, insert: inserted },
    userEvent: "ai",
  });
  return true;
}
