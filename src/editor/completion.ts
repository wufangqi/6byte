import { Annotation, Prec, StateEffect, StateField, type Transaction } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  WidgetType,
  type PluginValue,
  type ViewUpdate,
} from "@codemirror/view";
import {
  completionMessages,
  completionSlice,
  suggestionSettled,
  visibleSuggestion,
} from "../features/completion";
import type { AiMessage } from "../ipc/types";
import { loadCompletionEndpoint, loadCompletionSettings } from "../features/completionSettings";
import { inlineInsertField } from "./inlineInsert";

/** Marks a ghost-text update so it is not treated as the user typing. */
const completionMark = Annotation.define<true>();

const setGhost = StateEffect.define<string | null>();

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: GhostWidget): boolean {
    return this.text === other.text;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-ghost-text";
    span.textContent = this.text;
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function insertedAtHead(tr: Transaction): string | null {
  if (!tr.docChanged) return null;
  const head = tr.startState.selection.main.head;
  let text: string | null = null;
  let seen = false;
  tr.changes.iterChanges((from, to, _fromA, _toA, inserted) => {
    if (seen) {
      text = null;
      return;
    }
    seen = true;
    if (from !== head || from !== to) {
      text = null;
      return;
    }
    text = inserted.toString();
  });
  return text;
}

/** The uncommitted suggestion. Empty means nothing is showing. */
export const ghostText = StateField.define<string>({
  create: () => "",
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setGhost)) return effect.value ?? "";
    }
    if (tr.annotation(completionMark)) return value;
    if (!tr.docChanged) return tr.selection ? "" : value;
    const typed = insertedAtHead(tr);
    if (typed && value.startsWith(typed)) return value.slice(typed.length);
    return "";
  },
});

const ghostDecorations = EditorView.decorations.compute([ghostText], (state) => {
  const text = state.field(ghostText);
  if (!text) return Decoration.none;
  const pos = state.selection.main.head;
  return Decoration.set([Decoration.widget({ widget: new GhostWidget(text), side: 1 }).range(pos)]);
});

function rewritePending(view: EditorView): boolean {
  const marks = view.state.field(inlineInsertField, false);
  return Boolean(marks && marks.size > 0);
}

interface StreamHandlers {
  start(request: {
    providerId: string;
    baseUrl: string;
    model: string;
    profileId: string;
    messages: AiMessage[];
  }): Promise<string>;
  cancel(streamId: string): Promise<void>;
  listen(handlers: {
    token(event: { streamId: string; delta: string; kind?: string }): void;
    done(streamId: string): void;
  }): Promise<Array<() => void>>;
}

async function openClient(): Promise<StreamHandlers> {
  const api = await import("../ipc/api");
  return {
    start: (request) => api.aiStart(request),
    cancel: (streamId) => api.aiCancel(streamId),
    listen: (handlers) =>
      Promise.all([
        api.onAiToken((event) => handlers.token(event)),
        api.onAiDone((event) => handlers.done(event.streamId)),
        api.onAiError((event) => handlers.done(event.streamId)),
      ]),
  };
}

type EarlyEvent =
  { streamId: string; delta: string; kind?: string } | { streamId: string; done: true };

class CompletionPlugin implements PluginValue {
  private timer = 0;
  private ticket = 0;
  private streamId: string | null = null;
  private raw = "";
  private prefix = "";
  private early: EarlyEvent[] = [];
  private stops: Array<() => void> = [];
  private client: Promise<StreamHandlers> | null = null;
  private destroyed = false;

  constructor(readonly view: EditorView) {
    // Keymap commands (Tab / Esc) run outside the plugin, so they need this instance.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    activePlugin = this;
  }

  /** True while a completion request is still open. */
  pending(): boolean {
    return this.streamId !== null || this.timer !== 0;
  }

  update(update: ViewUpdate): void {
    const accepted = update.transactions.some(
      (tr) => tr.annotation(completionMark) && tr.docChanged
    );
    if (accepted) {
      this.schedule();
      return;
    }
    if (update.transactions.some((tr) => tr.annotation(completionMark))) return;
    const before = update.startState.field(ghostText);
    const after = update.state.field(ghostText);
    if (update.docChanged) {
      if (before && after && before.endsWith(after)) return;
      this.stop();
      this.schedule();
      return;
    }
    if (update.selectionSet && before) this.stop();
  }

  destroy(): void {
    this.destroyed = true;
    this.stop();
    this.stops.forEach((stop) => stop());
    if (activePlugin === this) activePlugin = null;
  }

  stop(): void {
    this.ticket += 1;
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = 0;
    const id = this.streamId;
    this.streamId = null;
    this.raw = "";
    this.early = [];
    if (id) void this.client?.then((client) => client.cancel(id).catch(() => {}));
  }

  private schedule(): void {
    if (!loadCompletionSettings().enabled) return;
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      void this.request();
    }, 450);
  }

  private async request(): Promise<void> {
    const settings = loadCompletionSettings();
    if (!settings.enabled || this.destroyed) return;
    const endpoint = loadCompletionEndpoint();
    if (!endpoint) return;
    const selection = this.view.state.selection.main;
    if (!selection.empty || this.view.state.selection.ranges.length !== 1) return;
    if (rewritePending(this.view)) return;
    const slice = completionSlice(this.view.state.doc.toString(), selection.head);
    if (!slice) return;
    const ticket = this.ticket;
    this.raw = "";
    this.prefix = slice.prefix;
    const client = await this.ensureClient();
    if (ticket !== this.ticket || this.destroyed) return;
    try {
      const id = await client.start({
        providerId: "openai-compatible",
        baseUrl: endpoint.baseUrl,
        model: endpoint.model,
        profileId: endpoint.id,
        messages: completionMessages(slice.prefix, slice.suffix),
      });
      if (ticket !== this.ticket || this.destroyed) {
        void client.cancel(id).catch(() => {});
        return;
      }
      this.streamId = id;
      const queued = this.early.splice(0);
      for (const event of queued) this.apply(event);
    } catch {
      /* a missing runtime or a refused request leaves the editor unchanged */
    }
  }

  private async ensureClient(): Promise<StreamHandlers> {
    if (!this.client) {
      this.client = openClient().then(async (client) => {
        const stops = await client.listen({
          token: (event) => this.onToken(event),
          done: (streamId) => this.apply({ streamId, done: true }),
        });
        if (this.destroyed) stops.forEach((stop) => stop());
        else this.stops = stops;
        return client;
      });
    }
    return this.client;
  }

  private onToken(event: { streamId: string; delta: string; kind?: string }): void {
    if (this.streamId === null) {
      this.early.push(event);
      return;
    }
    this.apply(event);
  }

  private apply(event: EarlyEvent): void {
    if (event.streamId !== this.streamId || this.destroyed) return;
    if ("done" in event) {
      this.streamId = null;
      return;
    }
    if (event.kind === "reasoning") return;
    this.raw += event.delta;
    const shown = visibleSuggestion(this.prefix, this.raw);
    this.view.dispatch({
      effects: setGhost.of(shown || null),
      annotations: completionMark.of(true),
    });
    if (suggestionSettled(this.raw) && this.streamId) {
      const id = this.streamId;
      this.streamId = null;
      void this.client?.then((client) => client.cancel(id).catch(() => {}));
    }
  }
}

let activePlugin: CompletionPlugin | null = null;

function paint(view: EditorView, text: string | null): void {
  view.dispatch({ effects: setGhost.of(text), annotations: completionMark.of(true) });
}

/** Test hook: show a suggestion without asking a model. */
export function previewGhost(view: EditorView, text: string): void {
  paint(view, text);
}

/** Insert the suggestion. One undo removes it. The file is not saved. */
export function acceptGhost(view: EditorView): boolean {
  const text = view.state.field(ghostText, false) ?? "";
  if (!text) return false;
  const pos = view.state.selection.main.head;
  activePlugin?.stop();
  view.dispatch({
    changes: { from: pos, to: pos, insert: text },
    effects: setGhost.of(null),
    annotations: completionMark.of(true),
    selection: { anchor: pos + text.length },
  });
  return true;
}

/** Drop the suggestion and any in-flight request. */
export function dismissGhost(view: EditorView): boolean {
  const text = view.state.field(ghostText, false) ?? "";
  const pending = activePlugin?.pending() ?? false;
  if (!text && !pending) return false;
  activePlugin?.stop();
  if (text) paint(view, null);
  return true;
}

/** Used by the master switch so turning it off drops a visible suggestion. */
export function dismissActiveCompletion(): void {
  const plugin = activePlugin;
  if (!plugin) return;
  const view = plugin.view;
  plugin.stop();
  if (view.state.field(ghostText, false)) paint(view, null);
}

export function completionExtension() {
  return [
    ghostText,
    ghostDecorations,
    ViewPlugin.fromClass(CompletionPlugin),
    Prec.highest(
      keymap.of([
        { key: "Tab", run: acceptGhost },
        { key: "Escape", run: dismissGhost },
      ])
    ),
  ];
}
