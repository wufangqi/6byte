import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  getEditorView,
  getSelectionSpan,
  readBuffer,
  subscribeDocChanges,
} from "../editor/registry";
import { armRewriteGate, disarmRewriteGate } from "../editor/rewriteGate";
import { clearRewritePreview, commitRewrite, showRewritePreview } from "../editor/rewritePreview";
import { localizeError, useI18n } from "../i18n";
import { aiCancel, aiStart, listDirChildren, readFile } from "../ipc/api";
import { abandonAiStream, claimAiStream, type AiStreamClaim } from "../ipc/aiStreamBus";
import type { AiUsage } from "../ipc/types";
import { useFileTree } from "../stores/fileTree";
import { useWorkspace } from "../stores/workspace";
import { activeModel, loadAiSettings } from "./aiSettings";
import {
  IDLE_STREAM,
  modelHost,
  outgoingChars,
  QUICK_ACTIONS,
  reduceStream,
  REWRITE_MAX_TOKENS,
  selectionTooLarge,
  type QuickActionId,
  type StreamView,
} from "./aiStream";
import { isMarkdownFile } from "./markdown";
import { extractHeadings } from "./outline";
import { assembleRewrite, type ContextPartId } from "./rewriteContext";
import { runReadAgent, type AgentTrace } from "./readAgent";
import { completeAgentTurn, workspaceAgentTools } from "./readAgentHost";
import {
  activeMentionQuery,
  buildReferences,
  collectWorkspaceFiles,
  insertMention,
  instructionWithoutMentions,
  mentionToken,
  parseMentions,
  relativePath,
  type WorkspaceFile,
} from "./workspaceQuery";

interface Props {
  tabId: string;
  onClose(): void;
  onNeedSettings(): void;
}

interface PendingRewrite {
  tabId: string;
  from: number;
  to: number;
  original: string;
  text: string;
}

type Note = "accepted" | "restored" | "stale" | null;

const PART_LABEL: Record<ContextPartId, string> = {
  selection: "ai.context.selection",
  section: "ai.context.section",
  neighbors: "ai.context.neighbors",
  filename: "ai.context.filename",
  outline: "ai.context.outline",
  references: "ai.context.references",
};

function same(item: PendingRewrite): boolean {
  const view = getEditorView(item.tabId);
  if (!view) return false;
  return view.state.sliceDoc(item.from, item.to) === item.original;
}

/** Remove the proposal decoration. The buffer itself was never changed. */
function clearProposal(item: PendingRewrite | null): void {
  if (!item) return;
  const view = getEditorView(item.tabId);
  if (view) clearRewritePreview(view);
}

/** Left: the instruction. Right: collapsible thinking. The reply is typed into the open editor. */
export default function AiStreamPanel({ tabId, onClose, onNeedSettings }: Props) {
  const { t } = useI18n();
  const [instruction, setInstruction] = useState("");
  const [mode, setMode] = useState<"rewrite" | "ask">("rewrite");
  const [asking, setAsking] = useState(false);
  const [agentAnswer, setAgentAnswer] = useState<string | null>(null);
  const [agentTrace, setAgentTrace] = useState<AgentTrace[]>([]);
  const [action, setAction] = useState<QuickActionId | null>(null);
  const [selection, setSelection] = useState("");
  const [view, setView] = useState<StreamView>(IDLE_STREAM);
  const [thinkingOpen, setThinkingOpen] = useState(true);
  const [offer, setOffer] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [excluded, setExcluded] = useState<ContextPartId[]>([]);
  const [span, setSpan] = useState<{ from: number; to: number; text: string } | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [referenceText, setReferenceText] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionCaret, setMentionCaret] = useState(0);
  const workspaceRoot = useFileTree((state) => state.rootPath);
  const listedFiles = workspaceRoot ? workspaceFiles : [];
  const tabName = useWorkspace((state) => state.tabs.find((item) => item.id === tabId)?.name ?? "");
  const tabSnapshot = useWorkspace(
    (state) => state.tabs.find((item) => item.id === tabId)?.content ?? ""
  );
  const rootRef = useRef<HTMLElement | null>(null);
  const streamId = useRef<string | null>(null);
  const epoch = useRef(0);
  const claimRef = useRef<AiStreamClaim | null>(null);
  const pending = useRef<PendingRewrite | null>(null);
  const viewRef = useRef(view);
  const thinkingRef = useRef<HTMLPreElement | null>(null);
  const followThinking = useRef(true);
  const settings = activeModel(loadAiSettings());
  const host = modelHost(settings?.baseUrl ?? "");
  const running = view.phase === "waiting" || view.phase === "streaming";
  const assembled = span
    ? assembleRewrite(
        span.text,
        instructionWithoutMentions(instruction) || instruction.trim(),
        {
          filename: tabName,
          document: readBuffer(tabId, tabSnapshot),
          from: span.from,
          to: span.to,
        },
        {
          exclude: excluded,
          references: parseMentions(instruction).length === 0 ? "" : referenceText,
        }
      )
    : null;
  const messages = assembled && instruction.trim() ? assembled.messages : [];
  const count = outgoingChars(messages);
  const contextParts = (assembled?.parts ?? []).filter((part) => part.available);

  const show = (next: StreamView) => {
    viewRef.current = next;
    setView(next);
  };

  const paint = (item: PendingRewrite) => {
    const editor = getEditorView(item.tabId);
    if (!editor || !same(item)) {
      pending.current = null;
      disarmRewriteGate(item.tabId);
      setOffer(false);
      setNote("stale");
      return;
    }
    showRewritePreview(editor, {
      from: item.from,
      to: item.to,
      text: item.text,
      originalLabel: t("ai.stream.original"),
      rewriteLabel: t("ai.stream.proposal"),
    });
  };

  const pushText = (delta: string) => {
    const item = pending.current;
    if (!item || !delta) return;
    if (!same(item)) {
      pending.current = null;
      disarmRewriteGate(item.tabId);
      setOffer(false);
      setNote("stale");
      return;
    }
    item.text += delta;
    paint(item);
    setOffer(true);
  };

  useEffect(() => {
    const read = () => {
      const next = getSelectionSpan(tabId);
      setSelection(next?.text ?? "");
      setSpan(next);
    };
    read();
    window.addEventListener("keyup", read);
    window.addEventListener("mouseup", read);
    const stop = subscribeDocChanges(tabId, read);
    return () => {
      window.removeEventListener("keyup", read);
      window.removeEventListener("mouseup", read);
      stop();
    };
  }, [tabId]);

  useEffect(() => {
    if (!workspaceRoot) return;
    let cancel = false;
    void collectWorkspaceFiles(workspaceRoot, listDirChildren).then((files) => {
      if (!cancel) setWorkspaceFiles(files);
    });
    return () => {
      cancel = true;
    };
  }, [workspaceRoot]);

  useEffect(() => {
    const found = parseMentions(instruction);
    if (found.length === 0) return;
    let cancel = false;
    void buildReferences(
      found,
      readBuffer(tabId, tabSnapshot),
      workspaceRoot ? workspaceFiles : [],
      workspaceRoot,
      readFile
    ).then((text) => {
      if (!cancel) setReferenceText(text);
    });
    return () => {
      cancel = true;
    };
  }, [instruction, tabId, tabSnapshot, workspaceFiles, workspaceRoot]);

  useEffect(() => {
    const node = thinkingRef.current;
    if (!node || !followThinking.current) return;
    node.scrollTop = node.scrollHeight;
  }, [view.thinking]);

  const apply = (
    event:
      | { kind: "delta"; streamId: string; delta: string; channel: "content" | "reasoning" }
      | { kind: "done"; streamId: string; usage?: AiUsage }
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
    if (event.kind === "done") setUsage(event.usage ?? null);
    if (event.kind === "error" || !next.text) {
      clearProposal(pending.current);
      if (pending.current) disarmRewriteGate(pending.current.tabId);
      pending.current = null;
      setOffer(false);
    }
  };

  const take = (
    event:
      | { kind: "delta"; streamId: string; delta: string; channel: "content" | "reasoning" }
      | { kind: "done"; streamId: string; usage?: AiUsage }
      | { kind: "error"; streamId: string; message: string }
  ) => {
    apply(event);
  };
  const takeRef = useRef(take);
  useEffect(() => {
    takeRef.current = take;
  });

  useEffect(() => {
    const claim = claimAiStream({
      token: (event) =>
        takeRef.current({
          kind: "delta",
          streamId: event.streamId,
          delta: event.delta,
          channel: event.kind === "reasoning" ? "reasoning" : "content",
        }),
      done: (event) =>
        takeRef.current({ kind: "done", streamId: event.streamId, usage: event.usage }),
      error: (event) =>
        takeRef.current({ kind: "error", streamId: event.streamId, message: event.message }),
    });
    claimRef.current = claim;
    return () => {
      claim.release();
      claimRef.current = null;
    };
  }, []);

  const discard = useCallback(() => {
    epoch.current += 1;
    const id = streamId.current;
    claimRef.current?.release();
    const item = pending.current;
    streamId.current = null;
    pending.current = null;
    setOffer(false);
    setUsage(null);
    setAction(null);
    if (item) {
      disarmRewriteGate(item.tabId);
      if (same(item)) {
        clearProposal(item);
        setNote("restored");
      } else setNote("stale");
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
    const editor = getEditorView(item.tabId);
    pending.current = null;
    disarmRewriteGate(item.tabId);
    setOffer(false);
    setAction(null);
    if (!editor || !same(item) || !commitRewrite(editor, item.from, item.to, item.text)) {
      clearProposal(item);
      setNote("stale");
      return;
    }
    setNote("accepted");
  };
  const acceptRef = useRef(accept);
  useLayoutEffect(() => {
    acceptRef.current = accept;
  });

  // Tab accepts the highlighted rewrite while the editor still has focus.
  // Capture phase so CodeMirror never indents the line first (T37).
  useEffect(() => {
    const onTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return;
      if (!pending.current?.text) return;
      const target = event.target as Node | null;
      const editor = document.querySelector(".cm-editor");
      if (!target || !editor?.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      acceptRef.current();
    };
    window.addEventListener("keydown", onTab, true);
    return () => window.removeEventListener("keydown", onTab, true);
  }, []);

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
    const ticket = epoch.current;
    const item: PendingRewrite = {
      tabId,
      from: span.from,
      to: span.to,
      original: span.text,
      text: "",
    };
    pending.current = item;
    armRewriteGate(tabId, () => discardRef.current());
    paint(item);
    setOffer(false);
    setNote(null);
    setUsage(null);
    streamId.current = null;
    followThinking.current = true;
    show(reduceStream(IDLE_STREAM, { type: "start" }));
    try {
      const tab = useWorkspace.getState().tabs.find((item) => item.id === tabId);
      const document = tab ? readBuffer(tab.id, tab.content) : readBuffer(tabId, "");
      const references = await buildReferences(
        parseMentions(request),
        document,
        listedFiles,
        workspaceRoot,
        readFile
      );
      const id = await aiStart({
        providerId: "openai-compatible",
        baseUrl: settings.baseUrl,
        model: settings.model,
        profileId: settings.id,
        maxTokens: REWRITE_MAX_TOKENS,
        messages: assembleRewrite(
          current,
          instructionWithoutMentions(request) || request,
          tab
            ? {
                filename: tab.name,
                document,
                from: span.from,
                to: span.to,
              }
            : null,
          { exclude: excluded, references }
        ).messages,
      });
      if (ticket !== epoch.current) {
        abandonAiStream(id);
        void aiCancel(id).catch(() => {});
        return;
      }
      streamId.current = id;
      claimRef.current?.bind(id);
    } catch (error) {
      streamId.current = null;
      const failed = pending.current;
      pending.current = null;
      if (failed) {
        disarmRewriteGate(failed.tabId);
        clearProposal(failed);
      }
      const message = error instanceof Error ? error.message : String(error);
      show(reduceStream(viewRef.current, { type: "error", message }));
    }
  };

  const askWorkspace = async () => {
    const request = instruction.trim();
    if (!workspaceRoot || !request || asking) return;
    if (!settings?.baseUrl.trim() || !settings.model.trim()) {
      onNeedSettings();
      return;
    }
    setAsking(true);
    setAgentAnswer(null);
    setAgentTrace([]);
    try {
      const result = await runReadAgent({
        question: request,
        root: workspaceRoot,
        tools: workspaceAgentTools(),
        complete: (messages) =>
          completeAgentTurn({
            baseUrl: settings.baseUrl,
            model: settings.model,
            profileId: settings.id,
            messages,
          }),
      });
      setAgentAnswer(result.answer);
      setAgentTrace(result.trace);
    } catch (error) {
      setAgentAnswer(localizeError(error));
    } finally {
      setAsking(false);
    }
  };

  const mentionChoices =
    mentionQuery === null
      ? []
      : [
          ...(isMarkdownFile(tabName)
            ? extractHeadings(readBuffer(tabId, tabSnapshot))
                .filter((heading) =>
                  heading.text.toLowerCase().includes(mentionQuery.toLowerCase())
                )
                .slice(0, 6)
                .map((heading) => ({
                  key: `heading:${heading.line}:${heading.text}`,
                  label: heading.text,
                  detail: "#".repeat(heading.level),
                  token: mentionToken({
                    kind: "heading" as const,
                    label: heading.text,
                    line: heading.line,
                  }),
                }))
            : []),
          ...listedFiles
            .filter((file) => {
              if (!workspaceRoot) return false;
              const relative = workspaceRoot ? relativePath(workspaceRoot, file.path) : file.name;
              const needle = mentionQuery.toLowerCase();
              return (
                relative.toLowerCase().includes(needle) || file.name.toLowerCase().includes(needle)
              );
            })
            .slice(0, 6)
            .map((file) => {
              const relative = workspaceRoot ? relativePath(workspaceRoot, file.path) : file.name;
              return {
                key: file.path,
                label: file.name,
                detail: relative,
                token: mentionToken({ kind: "file" as const, label: relative }),
              };
            }),
        ].slice(0, 8);

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
        <div className="ai-stream__modes" role="group" aria-label={t("ai.mode.label")}>
          <button
            type="button"
            className={`ai-stream__mode${mode === "rewrite" ? " is-on" : ""}`}
            aria-pressed={mode === "rewrite"}
            onClick={() => setMode("rewrite")}
          >
            {t("ai.mode.rewrite")}
          </button>
          <button
            type="button"
            className={`ai-stream__mode${mode === "ask" ? " is-on" : ""}`}
            aria-pressed={mode === "ask"}
            onClick={() => setMode("ask")}
          >
            {t("ai.mode.ask")}
          </button>
        </div>
        <span className="ai-stream__host">{host}</span>
        <button type="button" className="ai-stream__close" onClick={onClose}>
          {t("ai.stream.close")}
        </button>
      </div>
      <div className="ai-stream__columns">
        <div className="ai-stream__input-col">
          <p className="ai-stream__hint">
            {mode === "ask" ? t("ai.mode.askHint") : t("ai.stream.hint")}
          </p>
          {mode === "rewrite" && (
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
          )}
          <label className="ai-stream__field">
            <span>{t("ai.stream.instruction")}</span>
            <textarea
              className="ai-stream__input"
              rows={3}
              value={instruction}
              placeholder={
                mode === "ask" ? t("ai.mode.askPlaceholder") : t("ai.stream.placeholder")
              }
              onChange={(event) => {
                const value = event.target.value;
                const caret = event.target.selectionStart ?? value.length;
                setInstruction(value);
                setMentionCaret(caret);
                setMentionQuery(activeMentionQuery(value, caret));
                if (action) setAction(null);
              }}
              onKeyUp={(event) => {
                const caret = event.currentTarget.selectionStart ?? instruction.length;
                setMentionCaret(caret);
                setMentionQuery(activeMentionQuery(event.currentTarget.value, caret));
              }}
              onClick={(event) => {
                const caret = event.currentTarget.selectionStart ?? instruction.length;
                setMentionCaret(caret);
                setMentionQuery(activeMentionQuery(event.currentTarget.value, caret));
              }}
            />
            {mentionQuery !== null && (
              <ul className="ai-stream__mentions" role="listbox" aria-label={t("ai.mention.list")}>
                {mentionChoices.length === 0 ? (
                  <li className="ai-stream__mention-empty">{t("ai.mention.empty")}</li>
                ) : (
                  mentionChoices.map((choice) => (
                    <li key={choice.key}>
                      <button
                        type="button"
                        role="option"
                        className="ai-stream__mention"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          const next = insertMention(
                            instruction,
                            mentionCaret,
                            mentionQuery,
                            choice.token
                          );
                          setInstruction(next.text);
                          setMentionQuery(null);
                          if (action) setAction(null);
                        }}
                      >
                        <span>{choice.label}</span>
                        <span className="ai-stream__mention-detail">{choice.detail}</span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
          </label>
          <div className="ai-stream__meta">
            {mode === "rewrite" && !selection && <span>{t("ai.stream.selectionEmpty")}</span>}
            {mode === "rewrite" && selection && selectionTooLarge(selection) && (
              <span>{t("ai.stream.tooLarge")}</span>
            )}
            {mode === "rewrite" && count > 0 && !selectionTooLarge(selection) && (
              <span>{t("ai.stream.budget", { count, host })}</span>
            )}
          </div>
          {mode === "rewrite" &&
            selection &&
            !selectionTooLarge(selection) &&
            contextParts.length > 0 && (
              <div className="ai-stream__context" role="group" aria-label={t("ai.context.list")}>
                {contextParts.map((part) => (
                  <button
                    key={part.id}
                    type="button"
                    className={`ai-stream__chip${part.included ? " is-on" : ""}`}
                    aria-pressed={part.included}
                    disabled={running || part.id === "selection"}
                    title={part.dropped ? t("ai.context.dropped") : t(PART_LABEL[part.id])}
                    onClick={() => {
                      if (part.id === "selection") return;
                      setExcluded((current) =>
                        current.includes(part.id)
                          ? current.filter((item) => item !== part.id)
                          : [...current, part.id]
                      );
                    }}
                  >
                    {t(PART_LABEL[part.id])}
                  </button>
                ))}
              </div>
            )}
          <div className="ai-stream__actions">
            {mode === "ask" ? (
              <button
                type="button"
                className="btn btn--primary"
                disabled={asking || running || !workspaceRoot || !instruction.trim()}
                onClick={() => void askWorkspace()}
              >
                {asking ? t("ai.mode.asking") : t("ai.mode.askSend")}
              </button>
            ) : running ? (
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
          {mode === "ask" && !workspaceRoot && (
            <p className="ai-stream__status">{t("ai.mode.needWorkspace")}</p>
          )}
          {mode === "ask" && agentTrace.length > 0 && (
            <ol className="ai-stream__trace">
              {agentTrace.map((step, index) => (
                <li key={`${step.name}-${index}`}>
                  <span>{step.name}</span>
                  {step.detail ? (
                    <span className="ai-stream__mention-detail"> {step.detail}</span>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
          {mode === "ask" && agentAnswer && <p className="ai-stream__answer">{agentAnswer}</p>}
          {status && <p className="ai-stream__status">{status}</p>}
          {usage && (
            <p className="ai-stream__status">
              {t("ai.stream.usage", {
                prompt: usage.promptTokens,
                completion: usage.completionTokens,
              })}
            </p>
          )}
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
