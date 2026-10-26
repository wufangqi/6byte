import { undo } from "@codemirror/commands";
import { StateEffect, StateField, type EditorState, type TransactionSpec } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

/**
 * Side-by-side rewrite decorations.
 *
 * The proposal is not part of the document. Accept replaces the selection in
 * one undo step; cancel, failure, and save leave the buffer unchanged.
 */

export interface RewritePreview {
  from: number;
  to: number;
  /** Replacement. Empty while the model is still thinking. */
  text: string;
  originalLabel: string;
  rewriteLabel: string;
}

const setRewritePreview = StateEffect.define<RewritePreview | null>();

class LabelWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly kind: "original" | "rewrite"
  ) {
    super();
  }

  eq(other: LabelWidget): boolean {
    return other.label === this.label && other.kind === this.kind;
  }

  ignoreEvent(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `cm-ai-label cm-ai-label--${this.kind}`;
    span.textContent = this.label;
    return span;
  }
}

class RewriteWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly label: string
  ) {
    super();
  }

  eq(other: RewriteWidget): boolean {
    return other.text === this.text && other.label === this.label;
  }

  ignoreEvent(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-ai-proposal";
    const tag = document.createElement("span");
    tag.className = "cm-ai-label cm-ai-label--rewrite";
    tag.textContent = this.label;
    const body = document.createElement("span");
    body.className = "cm-ai-proposal__text";
    body.textContent = this.text;
    wrap.append(tag, body);
    return wrap;
  }
}

function previewDecorations(preview: RewritePreview): DecorationSet {
  const original = Decoration.mark({
    class: "cm-ai-original",
    attributes: { title: preview.originalLabel },
  }).range(preview.from, preview.to);
  const label = Decoration.widget({
    widget: new LabelWidget(preview.originalLabel, "original"),
    side: -1,
  }).range(preview.from);
  const marks = [label, original];
  if (preview.text) {
    marks.push(
      Decoration.widget({
        widget: new RewriteWidget(preview.text, preview.rewriteLabel),
        side: 1,
      }).range(preview.to)
    );
  }
  return Decoration.set(marks, true);
}

export const rewritePreviewField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    let next = deco;
    let replaced = false;
    for (const effect of tr.effects) {
      if (!effect.is(setRewritePreview)) continue;
      replaced = true;
      next = effect.value ? previewDecorations(effect.value) : Decoration.none;
    }
    if (replaced) return next;
    if (tr.docChanged) return Decoration.none;
    return deco.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function inRange(state: EditorState, preview: RewritePreview): boolean {
  return preview.from >= 0 && preview.to <= state.doc.length && preview.from < preview.to;
}

export function showRewritePreview(view: EditorView, preview: RewritePreview): void {
  if (!inRange(view.state, preview)) return;
  view.dispatch({ effects: setRewritePreview.of(preview) });
}

export function clearRewritePreview(view: EditorView): void {
  if (view.state.field(rewritePreviewField, false) === undefined) return;
  view.dispatch({ effects: setRewritePreview.of(null) });
}

/** Drop the marks from a cached state that is not currently in the view. */
export function stripRewritePreview(state: EditorState): EditorState {
  return state.update({ effects: setRewritePreview.of(null) }).state;
}

/** Replace the marked range in one history entry. One undo restores the original. */
export function commitRewrite(view: EditorView, from: number, to: number, text: string): boolean {
  if (from < 0 || to > view.state.doc.length || from >= to) return false;
  view.dispatch(commitSpec(from, to, text));
  return true;
}

function commitSpec(from: number, to: number, text: string): TransactionSpec {
  return {
    changes: { from, to, insert: text },
    effects: setRewritePreview.of(null),
    userEvent: "ai",
  };
}

/** Test hook: one undo after a commit restores the previous document. */
export function undoRewrite(view: EditorView): boolean {
  return undo(view);
}
