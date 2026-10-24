import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { acceptInline, cancelInline, paintInline } from "../editor/inlineInsert";
import { getEditorView, getSelectionSpan, getSelectionText } from "../editor/registry";
import { localizeError, useI18n } from "../i18n";
import { aiCancel, aiStart, onAiDone, onAiError, onAiToken } from "../ipc/api";
import { activeModel, loadAiSettings } from "./aiSettings";
import {
  IDLE_STREAM,
  modelHost,
  outgoingChars,
  QUICK_ACTIONS,
  quickActionMessages,
  reduceStream,
  selectionTooLarge,
  streamMessages,
  type QuickActionId,
  type StreamView,
} from "./aiStream";

interface Props {
  tabId: string;
  onClose(): void;
  onNeedSettings(): void;
}

interface PendingInsert {
  tabId: string;
  originalFrom: number;
  originalTo: number;
  original: string;
  insertFrom: number;
  insertTo: number;
  text: string;
}

type Note = "accepted" | "restored" | "stale" | null;

function same(item: PendingInsert): boolean {
  const view = getEditorView(item.tabId);
  if (!view) return false;
  return (
    view.state.sliceDoc(item.originalFrom, item.originalTo) === item.original &&
    view.state.sliceDoc(item.insertFrom, item.insertTo) === item.text
  );
}

/** Delete the highlighted insert. Returns false when the document no longer matches. */
function erase(item: PendingInsert | null): boolean {
  if (!item) return true;
  if (!item.text) return true;
  if (!same(item)) return false;
  const view = getEditorView(item.tabId);
  if (!view) return false;
  cancelInline(view, item.insertFrom, item.insertTo);
  return true;
}

/** Left: the instruction. Right: collapsible thinking. The reply is typed into the open editor. */
export default function AiStreamPanel({ tabId, onClose, onNeedSettings }: Props) {
  const { t } = useI18n();
  const [instruction, setInstruction] = useState("");
  const [action, setAction] = useState<QuickActionId | null>(null);
  const [selection, setSelection] = useState("");
  const [view, setView] = useState<StreamView>(IDLE_STREAM);
  const [thinkingOpen, setThinkingOpen] = useState(true);
  const [offer, setOffer] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const streamId = useRef<string | null>(null);
  const pending = useRef<PendingInsert | null>(null);
  const viewRef = useRef(view);
  const thinkingRef = useRef<HTMLPreElement | null>(null);
  const followThinking = useRef(true);
  const early = useRef<
    Array<
      | { kind: "delta"; streamId: string; delta: string; channel: "content" | "reasoning" }
      | { kind: "done"; streamId: string }
      | { kind: "error"; streamId: string; message: string }
    >
  >([]);
  const settings = activeModel(loadAiSettings());
  const host = modelHost(settings?.baseUrl ?? "");
  const running = view.phase === "waiting" || view.phase === "streaming";
  const messages = selection && instruction.trim() ? streamMessages(selection, instruction) : [];
  const count = outgoingChars(messages);

  const show = (next: StreamView) => {
    viewRef.current = next;
    setView(next);
  };

  const pushText = (delta: string) => {
    const item = pending.current;
    if (!item || !delta) return;
    const view = getEditorView(item.tabId);
    if (!view || !same(item)) {
      pending.current = null;
      setOffer(false);
      setNote("stale");
      return;
    }
    item.insertTo = paintInline(view, item.insertFrom, item.insertTo, delta);
    item.text += delta;
    setOffer(true);
  };

  useEffect(() => {
    const read = () => setSelection(getSelectionText(tabId) ?? "");
    read();
    window.addEventListener("keyup", read);
    window.addEventListener("mouseup", read);
    return () => {
      window.removeEventListener("keyup", read);
      window.removeEventListener("mouseup", read);
    };
  }, [tabId]);

  useEffect(() => {
    const node = thinkingRef.current;
    if (!node || !followThinking.current) return;
    node.scrollTop = node.scrollHeight;
  }, [view.thinking]);

  const apply = (
    event:
      | { kind: "delta"; streamId: string; delta: string; channel: "content" | "reasoning" }
      | { kind: "done"; streamId: string }
      | { kind: "error"; streamId: string; message: string }
  ) => {
    if (event.streamId !== streamId.current) return;
    if (event.kind === "delta") {
      const next = reduceStream(viewRef.current, {
        type: "delta",
        delta: event.delta,
        kind: event.channel,
      });
      show(next);
      if (event.channel === "content") pushText(event.delta);
      return;
    }
    streamId.current = null;
    const next = reduceStream(
      viewRef.current,
      event.kind === "done" ? { type: "done" } : { type: "error", message: event.message }
    );
    show(next);
    if (!next.text) {
      erase(pending.current);
      pending.current = null;
      setOffer(false);
    }
  };

  const take = (
    event:
      | { kind: "delta"; streamId: string; delta: string; channel: "content" | "reasoning" }
      | { kind: "done"; streamId: string }
      | { kind: "error"; streamId: string; message: string }
  ) => {
    if (streamId.current === null) {
      early.current.push(event);
      return;
    }
    apply(event);
  };
  const takeRef = useRef(take);
  useEffect(() => {
    takeRef.current = take;
  });

  useEffect(() => {
    let stops: Array<() => void> = [];
    let closed = false;
    void (async () => {
      const next = await Promise.all([
        onAiToken((event) =>
          takeRef.current({
            kind: "delta",
            streamId: event.streamId,
            delta: event.delta,
            channel: event.kind === "reasoning" ? "reasoning" : "content",
          })
        ),
        onAiDone((event) => takeRef.current({ kind: "done", streamId: event.streamId })),
        onAiError((event) =>
          takeRef.current({ kind: "error", streamId: event.streamId, message: event.message })
        ),
      ]);
      if (closed) next.forEach((stop) => stop());
      else stops = next;
    })();
    return () => {
      closed = true;
      stops.forEach((stop) => stop());
    };
  }, []);

  const discard = useCallback(() => {
    const id = streamId.current;
    const item = pending.current;
    streamId.current = null;
    pending.current = null;
    setOffer(false);
    setAction(null);
    if (item?.text) {
      if (erase(item)) setNote("restored");
      else setNote("stale");
    }
    if (item || id) {
      const next = reduceStream(viewRef.current, { type: "cancel" });
      viewRef.current = next;
      setView(next);
    }
    if (id) void aiCancel(id).catch(() => {});
  }, []);
  const discardRef = useRef(discard);
  useLayoutEffect(() => {
    discardRef.current = discard;
  }, [discard]);

  // Drop the highlight before the editor swaps documents. The shared view still
  // shows this tab during layout; the swap itself happens in a later effect.
  useLayoutEffect(() => {
    return () => discardRef.current();
  }, [tabId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (streamId.current || pending.current?.text) {
        event.preventDefault();
        event.stopPropagation();
        discardRef.current();
        return;
      }
      if (rootRef.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const accept = () => {
    const item = pending.current;
    if (!item?.text) return;
    const view = getEditorView(item.tabId);
    pending.current = null;
    setOffer(false);
    setAction(null);
    if (!view || !same(item)) {
      setNote("stale");
      return;
    }
    acceptInline(view, item.originalFrom, item.originalTo, item.insertFrom, item.insertTo);
    setNote("accepted");
  };

  const send = async (prompt?: string) => {
    const span = getSelectionSpan(tabId);
    const current = span?.text ?? "";
    const request = (prompt ?? instruction).trim();
    setSelection(current);
    if (!settings?.baseUrl.trim() || !settings.model.trim()) {
      onNeedSettings();
      return;
    }
    if (!span || selectionTooLarge(current) || !request) return;
    if (pending.current) discard();
    pending.current = {
      tabId,
      originalFrom: span.from,
      originalTo: span.to,
      original: span.text,
      insertFrom: span.to,
      insertTo: span.to,
      text: "",
    };
    setOffer(false);
    setNote(null);
    streamId.current = null;
    early.current = [];
    followThinking.current = true;
    show(reduceStream(IDLE_STREAM, { type: "start" }));
    try {
      const id = await aiStart({
        providerId: "openai-compatible",
        baseUrl: settings.baseUrl,
        model: settings.model,
        profileId: settings.id,
        messages: prompt ? quickActionMessages(current, request) : streamMessages(current, request),
      });
      streamId.current = id;
      const queued = early.current.splice(0);
      for (const event of queued) apply(event);
    } catch (error) {
      streamId.current = null;
      pending.current = null;
      const message = error instanceof Error ? error.message : String(error);
      show(reduceStream(viewRef.current, { type: "error", message }));
    }
  };

  const status =
    note === "accepted"
      ? t("ai.stream.accepted")
      : note === "restored"
        ? t("ai.stream.restored")
        : note === "stale"
          ? t("ai.stream.stale")
          : view.phase === "waiting"
            ? t("ai.stream.waiting")
            : view.phase === "done"
              ? view.text
                ? t("ai.stream.done")
                : t("ai.stream.empty")
              : view.phase === "cancelled"
                ? t("ai.stream.cancelled")
                : view.phase === "error" && view.error
                  ? localizeError(view.error)
                  : null;

  return (
    <section className="ai-stream" ref={rootRef} aria-label={t("ai.stream.title")}>
      <div className="ai-stream__head">
        <strong>{t("ai.stream.title")}</strong>
        <span className="ai-stream__host">{host}</span>
        <button type="button" className="ai-stream__close" onClick={onClose}>
          {t("ai.stream.close")}
        </button>
      </div>
      <div className="ai-stream__columns">
        <div className="ai-stream__input-col">
          <p className="ai-stream__hint">{t("ai.stream.hint")}</p>
          <div className="ai-stream__presets" role="group" aria-label={t("ai.stream.actions")}>
            {QUICK_ACTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`btn ai-stream__preset${action === item.id ? " is-on" : ""}`}
                title={t(item.promptKey)}
                disabled={running || !selection || selectionTooLarge(selection)}
                onClick={() => {
                  const prompt = t(item.promptKey);
                  setInstruction(prompt);
                  setAction(item.id);
                  void send(prompt);
                }}
              >
                {t(item.labelKey)}
              </button>
            ))}
          </div>
          <label className="ai-stream__field">
            <span>{t("ai.stream.instruction")}</span>
            <textarea
              className="ai-stream__input"
              rows={3}
              value={instruction}
              placeholder={t("ai.stream.placeholder")}
              onChange={(event) => {
                setInstruction(event.target.value);
                if (action) setAction(null);
              }}
            />
          </label>
          <div className="ai-stream__meta">
            {!selection && <span>{t("ai.stream.selectionEmpty")}</span>}
            {selection && selectionTooLarge(selection) && <span>{t("ai.stream.tooLarge")}</span>}
            {count > 0 && !selectionTooLarge(selection) && (
              <span>{t("ai.stream.budget", { count, host })}</span>
            )}
          </div>
          <div className="ai-stream__actions">
            {running ? (
              <button type="button" className="btn" onClick={discard}>
                {t("ai.stream.cancel")}
              </button>
            ) : offer ? (
              <>
                <button type="button" className="btn btn--primary" onClick={accept}>
                  {t("ai.stream.accept")}
                </button>
                <button type="button" className="btn" onClick={discard}>
                  {t("ai.stream.cancel")}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                disabled={!selection || selectionTooLarge(selection) || !instruction.trim()}
                onClick={() => {
                  setAction(null);
                  void send();
                }}
              >
                {t("ai.stream.send")}
              </button>
            )}
          </div>
          {status && <p className="ai-stream__status">{status}</p>}
        </div>
        <details
          className="ai-stream__thinking"
          open={thinkingOpen}
          onToggle={(event) => setThinkingOpen(event.currentTarget.open)}
        >
          <summary>{t("ai.stream.thinking")}</summary>
          <pre
            ref={thinkingRef}
            onScroll={(event) => {
              const node = event.currentTarget;
              followThinking.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
            }}
          >
            {view.thinking || t("ai.stream.thinkingEmpty")}
          </pre>
        </details>
      </div>
    </section>
  );
}
