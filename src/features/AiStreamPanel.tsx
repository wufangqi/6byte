import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  getEditorView,
  getSelectionSpan,
  insertTextAtSelection,
  readBuffer,
  subscribeDocChanges,
  subscribeSourceSelection,
} from "../editor/registry";
import { armRewriteGate, disarmRewriteGate } from "../editor/rewriteGate";
import { clearRewritePreview, commitRewrite, showRewritePreview } from "../editor/rewritePreview";
import { localizeError, useI18n } from "../i18n";
import { aiCancel, aiStart, listDirChildren, readFile } from "../ipc/api";
import { abandonAiStream, claimAiStream, type AiStreamClaim } from "../ipc/aiStreamBus";
import type { AiMessage, AiUsage } from "../ipc/types";
import { useFileTree } from "../stores/fileTree";
import { useWorkspace } from "../stores/workspace";
import { activeModel, loadAiSettings, saveAiSettings, type AiCatalog } from "./aiSettings";
import {
  recordAiAcceptance,
  recordAiCancellation,
  recordAiFailure,
  recordAiFirstToken,
  recordAiOffer,
  recordAiRequest,
  recordAiSuccess,
} from "./aiMetrics";
import {
  IDLE_STREAM,
  modelHost,
  outgoingChars,
  QUICK_ACTIONS,
  reduceStream,
  selectionTooLarge,
  type StreamView,
} from "./aiStream";
import {
  clearHistory,
  loadHistory,
  newChatId,
  removeConversation,
  restoreEntries,
  saveConversation,
  seconds,
  type AskEntry,
  type ChatEntry,
  type ChatMode,
  type Conversation,
  type RewriteEntry,
  type RewriteStatus,
} from "./aiHistory";
import {
  BotHeader,
  HistoryList,
  PanelIcon,
  ProcessRow,
  RewriteCard,
  TraceList,
  UserBubble,
  CopyAction,
} from "./AiPanelParts";
import { isMarkdownFile } from "./markdown";
import { AppLogo } from "./MenuBar";
import { extractHeadings } from "./outline";
import { assembleRewrite, type ContextPartId } from "./rewriteContext";
import {
  appendRewriteTurn,
  rewriteFollowupMessages,
  type RewriteTurn,
} from "./rewriteConversation";
import { loadDenylist } from "./agentAccess";
import {
  ContextOverflowError,
  messageTokens,
  replyTokens,
  useActiveLimits,
  type AiLimits,
} from "./aiLimits";
import { askHistory, runReadAgent, type AgentTrace } from "./readAgent";
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
import AgentAnswer from "./AgentAnswer";

interface Props {
  tabId: string;
  onClose(): void;
  onNeedSettings(): void;
  onOpenMatch(path: string, line: number): void;
  panelWidth?: number;
  /** False while a Markdown tab shows only its preview; review then happens in the panel. */
  sourceShown?: boolean;
}

interface PendingRewrite {
  tabId: string;
  from: number;
  to: number;
  original: string;
  text: string;
  onAccept?(): void;
  onDiscard?(): void;
}

interface RewriteSession {
  baseMessages: AiMessage[];
  turns: RewriteTurn[];
}

/** Rounds to replay, ending with the draft on screen (which per-block review may have edited). */
function roundsWithDraft(session: RewriteSession, draft: string): RewriteTurn[] {
  const last = session.turns.at(-1);
  if (!last) return [{ instruction: "", proposal: draft }];
  return [...session.turns.slice(0, -1), { ...last, proposal: draft }];
}

function followupFor(
  session: RewriteSession,
  draft: string,
  instruction: string,
  references: string,
  limits: AiLimits,
  contextTokens?: number
): AiMessage[] {
  return rewriteFollowupMessages({
    base: session.baseMessages,
    turns: roundsWithDraft(session, draft),
    instruction,
    references,
    historyTurns: limits.historyTurns,
    historyChars: limits.historyChars,
    contextTokens,
  });
}

/** Questions answered earlier in this conversation, oldest first. */
function askedPairs(entries: readonly ChatEntry[]): { question: string; answer: string }[] {
  const pairs: { question: string; answer: string }[] = [];
  entries.forEach((entry, index) => {
    if (entry.role !== "ask" || entry.status !== "done" || !entry.answer.trim()) return;
    const asked = entries[index - 1];
    if (asked?.role === "user" && asked.mode === "ask") {
      pairs.push({ question: asked.text, answer: entry.answer });
    }
  });
  return pairs;
}

interface RewriteMetric {
  startedAt: number;
  firstToken: boolean;
  settled: boolean;
  offered: boolean;
}

interface ActiveRewrite {
  instruction: string;
  /** Existing candidate preserved while a follow-up is in flight. */
  previousText: string | null;
  replacedPrevious: boolean;
  metric: RewriteMetric;
}

type Note = "accepted" | "restored" | "followupRestored" | "stale" | null;
type Menu = "history" | "context" | null;

const PART_LABEL: Record<ContextPartId, string> = {
  selection: "ai.context.selection",
  section: "ai.context.section",
  neighbors: "ai.context.neighbors",
  filename: "ai.context.filename",
  outline: "ai.context.outline",
  references: "ai.context.references",
};

function metricNow(): number {
  return performance.now();
}

function same(item: PendingRewrite): boolean {
  const view = getEditorView(item.tabId);
  if (!view) return false;
  return view.state.sliceDoc(item.from, item.to) === item.original;
}

function selectionKey(span: { from: number; to: number; text: string }): string {
  return `${span.from}:${span.to}:${span.text}`;
}

function selectionExcerpt(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 88 ? `${compact.slice(0, 88)}…` : compact;
}

/** 1-based first and last line of a selection, or null when the editor is gone. */
function selectionLines(
  tabId: string,
  span: { from: number; to: number }
): [number, number] | null {
  const view = getEditorView(tabId);
  if (!view) return null;
  const doc = view.state.doc;
  const first = doc.lineAt(Math.min(span.from, doc.length)).number;
  const last = doc.lineAt(Math.min(Math.max(span.from, span.to - 1), doc.length)).number;
  return [first, last];
}

function isLocalHost(host: string): boolean {
  return /^(localhost|127\.|\[::1\]|::1)/i.test(host);
}

/** Remove the proposal decoration. The buffer itself was never changed. */
function clearProposal(item: PendingRewrite | null): void {
  if (!item) return;
  const view = getEditorView(item.tabId);
  if (view) clearRewritePreview(view);
}

/** The reply is typed into the open editor; this dock only gathers and reviews AI work. */
export default function AiStreamPanel({
  tabId,
  onClose,
  onNeedSettings,
  onOpenMatch,
  panelWidth = 420,
  sourceShown = true,
}: Props) {
  const { t } = useI18n();
  const [instruction, setInstruction] = useState("");
  const [catalog, setCatalog] = useState<AiCatalog>(loadAiSettings);
  const [mode, setMode] = useState<ChatMode>("rewrite");
  const [asking, setAsking] = useState(false);
  const [agentTrace, setAgentTrace] = useState<AgentTrace[]>([]);
  const [agentSent, setAgentSent] = useState(0);
  const [view, setView] = useState<StreamView>(IDLE_STREAM);
  const [offer, setOffer] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [rewriteSession, setRewriteSession] = useState<RewriteSession | null>(null);
  const [proposal, setProposal] = useState("");
  const [excluded, setExcluded] = useState<ContextPartId[]>([]);
  const [span, setSpan] = useState<{ from: number; to: number; text: string } | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [referenceText, setReferenceText] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionCaret, setMentionCaret] = useState(0);
  const [conversationId, setConversationId] = useState(newChatId);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [openProcess, setOpenProcess] = useState<string[]>([]);
  const [menu, setMenu] = useState<Menu>(null);
  const [history, setHistory] = useState<Conversation[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const workspaceRoot = useFileTree((state) => state.rootPath);
  const listedFiles = workspaceRoot ? workspaceFiles : [];
  const tabName = useWorkspace((state) => state.tabs.find((item) => item.id === tabId)?.name ?? "");
  const tabSnapshot = useWorkspace(
    (state) => state.tabs.find((item) => item.id === tabId)?.content ?? ""
  );
  const rootRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const menuRef = useRef<Menu>(null);
  const streamId = useRef<string | null>(null);
  const askAbort = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const claimRef = useRef<AiStreamClaim | null>(null);
  const pending = useRef<PendingRewrite | null>(null);
  const sessionRef = useRef<RewriteSession | null>(null);
  const activeRewrite = useRef<ActiveRewrite | null>(null);
  const dismissedSelection = useRef<string | null>(null);
  const viewRef = useRef(view);
  const thinkingRef = useRef<HTMLPreElement | null>(null);
  const followThinking = useRef(true);
  /** Entry streaming right now, and the entry whose candidate sits in the editor. */
  const liveEntryId = useRef<string | null>(null);
  const pendingEntryId = useRef<string | null>(null);
  const [thinkingById, setThinkingById] = useState<Record<string, string>>({});
  const keepThinking = useCallback((id: string, thinking: string) => {
    if (thinking) setThinkingById((current) => ({ ...current, [id]: thinking }));
  }, []);
  /** Entries restored from history; saving them again would only reorder the list. */
  const restoredEntries = useRef<ChatEntry[] | null>(null);
  const settings = activeModel(catalog);
  const limits = useActiveLimits();
  const host = modelHost(settings?.baseUrl ?? "");
  const running = view.phase === "waiting" || view.phase === "streaming";
  const modelValue = `${catalog.activeProviderId}|${catalog.activeModelId}`;
  const modelChoices = catalog.providers.flatMap((provider) =>
    provider.models
      .filter((model) => model.enabled || `${provider.id}|${model.id}` === modelValue)
      .map((model) => ({
        value: `${provider.id}|${model.id}`,
        label: `${provider.name || provider.baseUrl || "服务商"} · ${model.name || model.model}`,
        short: model.name || model.model,
      }))
  );
  const currentChoice = modelChoices.find((choice) => choice.value === modelValue);
  const switchModel = (value: string) => {
    if (running || asking) return;
    const [providerId, modelId] = value.split("|");
    const provider = catalog.providers.find((item) => item.id === providerId);
    if (!provider?.models.some((model) => model.id === modelId)) return;
    const next = { ...catalog, activeProviderId: providerId, activeModelId: modelId };
    saveAiSettings(next);
    setCatalog(next);
  };
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
          extraBudget: limits.contextChars,
        }
      )
    : null;
  const followupPreview =
    offer && rewriteSession && proposal && instruction.trim()
      ? followupFor(
          rewriteSession,
          proposal,
          instructionWithoutMentions(instruction) || instruction.trim(),
          parseMentions(instruction).length === 0 ? "" : referenceText,
          limits,
          settings?.contextTokens
        )
      : null;
  const messages = followupPreview ?? (assembled && instruction.trim() ? assembled.messages : []);
  const count = outgoingChars(messages);
  const contextParts = (assembled?.parts ?? []).filter((part) => part.available);
  const spanTooLarge = span ? selectionTooLarge(span.text, limits.selectionChars) : false;
  const failureText = (error: unknown) =>
    error instanceof ContextOverflowError
      ? t("ai.limits.overflow", { prompt: error.promptTokens, context: error.contextTokens })
      : localizeError(error);

  const show = useCallback((next: StreamView) => {
    viewRef.current = next;
    setView(next);
  }, []);

  const patchEntry = useCallback(
    (id: string | null, patch: Partial<RewriteEntry> | Partial<AskEntry>) => {
      if (!id) return;
      setEntries((list) =>
        list.map((entry) => (entry.id === id ? ({ ...entry, ...patch } as ChatEntry) : entry))
      );
    },
    []
  );

  /** Settle the streaming entry and the entry whose candidate is in the editor. */
  const settleEntries = useCallback(
    (live: RewriteStatus | null, shown: RewriteStatus | null, error?: string) => {
      const liveId = liveEntryId.current;
      const shownId = pendingEntryId.current;
      if (live && liveId) {
        keepThinking(liveId, viewRef.current.thinking);
        patchEntry(liveId, { status: live, ...(error ? { error } : {}) });
        liveEntryId.current = null;
      }
      if (shown && shownId && shownId !== liveId) {
        patchEntry(shownId, { status: shown });
        pendingEntryId.current = null;
      }
    },
    [keepThinking, patchEntry]
  );

  const clearRewriteSession = useCallback(() => {
    sessionRef.current = null;
    setRewriteSession(null);
    setProposal("");
  }, []);

  const settleRewriteMetric = useCallback(
    (outcome: "success" | "failed" | "cancelled", usage?: AiUsage) => {
      const request = activeRewrite.current;
      const metric = request?.metric;
      if (!request || !metric || metric.settled) return;
      activeRewrite.current = { ...request, metric: { ...metric, settled: true } };
      if (outcome === "success") recordAiSuccess("rewrite", usage);
      else if (outcome === "failed") recordAiFailure("rewrite");
      else recordAiCancellation("rewrite");
    },
    []
  );

  const markStale = useCallback(
    (item: PendingRewrite) => {
      pending.current = null;
      disarmRewriteGate(item.tabId);
      setOffer(false);
      setNote("stale");
      settleEntries("stale", "stale");
    },
    [settleEntries]
  );

  const paint = useCallback(
    (item: PendingRewrite) => {
      const editor = getEditorView(item.tabId);
      if (!editor || !same(item)) {
        markStale(item);
        return;
      }
      const canDecide = Boolean(
        item.text && activeRewrite.current === null && streamId.current === null
      );
      showRewritePreview(editor, {
        from: item.from,
        to: item.to,
        text: item.text,
        originalLabel: t("ai.stream.original"),
        rewriteLabel: t("ai.stream.proposal"),
        onAccept: canDecide ? item.onAccept : undefined,
        onDiscard: canDecide ? item.onDiscard : undefined,
        acceptLabel: canDecide ? t("ai.review.acceptBlock") : undefined,
        discardLabel: canDecide ? t("ai.review.keepOriginal") : undefined,
      });
    },
    [markStale, t]
  );

  const restorePreviousProposal = useCallback(() => {
    const request = activeRewrite.current;
    const item = pending.current;
    if (!request || request.previousText === null || !item || !same(item)) return false;
    item.text = request.previousText;
    paint(item);
    setProposal(item.text);
    setOffer(true);
    setNote("followupRestored");
    return true;
  }, [paint]);

  const pushText = (delta: string) => {
    const item = pending.current;
    if (!item || !delta) return;
    if (!same(item)) {
      markStale(item);
      return;
    }
    let request = activeRewrite.current;
    if (request && request.previousText !== null && !request.replacedPrevious) {
      item.text = "";
      request = { ...request, replacedPrevious: true };
      activeRewrite.current = request;
    }
    if (request && !request.metric.offered) {
      request = { ...request, metric: { ...request.metric, offered: true } };
      activeRewrite.current = request;
      recordAiOffer("rewrite");
    }
    item.text += delta;
    paint(item);
    setProposal(item.text);
    setOffer(true);
  };

  useEffect(() => {
    const read = () => {
      const next = getSelectionSpan(tabId);
      if (!next) {
        dismissedSelection.current = null;
        setSpan(null);
        return;
      }
      const key = selectionKey(next);
      if (dismissedSelection.current === key) return;
      dismissedSelection.current = null;
      setSpan(next);
    };
    read();
    window.addEventListener("keyup", read);
    window.addEventListener("mouseup", read);
    const stop = subscribeDocChanges(tabId, read);
    const stopSource = subscribeSourceSelection(tabId, read);
    return () => {
      window.removeEventListener("keyup", read);
      window.removeEventListener("mouseup", read);
      stop();
      stopSource();
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

  useEffect(() => {
    if (entries.length === 0 || entries === restoredEntries.current) return;
    saveConversation({ id: conversationId, entries });
  }, [conversationId, entries]);

  useLayoutEffect(() => {
    const node = listRef.current;
    if (node && stickToBottom.current) node.scrollTop = node.scrollHeight;
  }, [entries, view.text, view.thinking, agentTrace, note, openProcess]);

  useEffect(() => {
    menuRef.current = menu;
    if (!menu) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".ai-stream__menu-anchor")) return;
      setMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menu]);

  const apply = (
    event:
      | { kind: "delta"; streamId: string; delta: string; channel: "content" | "reasoning" }
      | { kind: "done"; streamId: string; usage?: AiUsage }
      | { kind: "error"; streamId: string; message: string }
  ) => {
    if (event.streamId !== streamId.current) return;
    if (event.kind === "delta") {
      const request = activeRewrite.current;
      const metric = request?.metric;
      if (request && metric && !metric.firstToken) {
        activeRewrite.current = { ...request, metric: { ...metric, firstToken: true } };
        recordAiFirstToken("rewrite", metricNow() - metric.startedAt);
      }
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
    const request = activeRewrite.current;
    const elapsedMs = request ? metricNow() - request.metric.startedAt : undefined;
    const liveId = liveEntryId.current;
    if (liveId) keepThinking(liveId, next.thinking);
    if (event.kind === "done") {
      settleRewriteMetric("success", event.usage);
      if (next.text && request) {
        const item = pending.current;
        if (item && same(item)) {
          activeRewrite.current = null;
          streamId.current = null;
          paint(item);
        }
        const session = sessionRef.current;
        if (session) {
          const nextSession: RewriteSession = {
            ...session,
            turns: appendRewriteTurn(session.turns, {
              instruction: request.instruction,
              proposal: next.text,
            }),
          };
          sessionRef.current = nextSession;
          setRewriteSession(nextSession);
        }
        activeRewrite.current = null;
        if (liveId && pending.current) {
          const previous = pendingEntryId.current;
          if (previous && previous !== liveId) patchEntry(previous, { status: "superseded" });
          patchEntry(liveId, {
            status: "pending",
            text: next.text,
            usage: event.usage,
            elapsedMs,
          });
          pendingEntryId.current = liveId;
          liveEntryId.current = null;
        }
      } else if (request?.previousText != null && restorePreviousProposal()) {
        activeRewrite.current = null;
        patchEntry(liveId, { status: "failed", elapsedMs, usage: event.usage });
        liveEntryId.current = null;
        return;
      }
    } else {
      settleRewriteMetric("failed");
      if (restorePreviousProposal()) {
        activeRewrite.current = null;
        patchEntry(liveId, {
          status: "failed",
          error: localizeError(event.message),
          elapsedMs,
        });
        liveEntryId.current = null;
        return;
      }
    }
    if (event.kind === "error" || !next.text) {
      clearProposal(pending.current);
      if (pending.current) disarmRewriteGate(pending.current.tabId);
      pending.current = null;
      activeRewrite.current = null;
      clearRewriteSession();
      setOffer(false);
      patchEntry(liveId, {
        status: "failed",
        elapsedMs,
        ...(event.kind === "error" ? { error: localizeError(event.message) } : {}),
      });
      liveEntryId.current = null;
      if (pendingEntryId.current !== liveId) settleEntries(null, "discarded");
      pendingEntryId.current = null;
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
    settleRewriteMetric("cancelled");
    streamId.current = null;
    pending.current = null;
    activeRewrite.current = null;
    clearRewriteSession();
    setOffer(false);
    if (item) {
      disarmRewriteGate(item.tabId);
      if (same(item)) {
        clearProposal(item);
        setNote("restored");
        settleEntries("cancelled", "discarded");
      } else {
        setNote("stale");
        settleEntries("stale", "stale");
      }
    } else settleEntries("cancelled", null);
    if (item || id) {
      const next = reduceStream(viewRef.current, { type: "cancel" });
      viewRef.current = next;
      setView(next);
    }
    if (id) void aiCancel(id).catch(() => {});
  }, [clearRewriteSession, settleEntries, settleRewriteMetric]);
  /** Cancelling a follow-up keeps the last stable draft available for review. */
  const cancelRewrite = useCallback(() => {
    const request = activeRewrite.current;
    if (!request || request.previousText === null) {
      discard();
      return;
    }
    epoch.current += 1;
    const id = streamId.current;
    claimRef.current?.release();
    streamId.current = null;
    settleRewriteMetric("cancelled");
    const restored = restorePreviousProposal();
    activeRewrite.current = null;
    if (restored) {
      settleEntries("cancelled", null);
      const next = reduceStream(viewRef.current, { type: "cancel" });
      viewRef.current = next;
      setView(next);
    } else {
      discard();
    }
    if (id) void aiCancel(id).catch(() => {});
  }, [discard, restorePreviousProposal, settleEntries, settleRewriteMetric]);

  // Drop the highlight before the editor swaps documents. The shared view still
  // shows this tab during layout; the swap itself happens in a later effect.
  useLayoutEffect(() => {
    return () => discard();
  }, [discard, tabId]);

  // Closing the panel stops a running question; it must not keep sending files.
  useEffect(() => {
    return () => askAbort.current?.abort();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (menuRef.current) {
        event.preventDefault();
        event.stopPropagation();
        setMenu(null);
        return;
      }
      if (askAbort.current) {
        event.preventDefault();
        event.stopPropagation();
        askAbort.current.abort();
        return;
      }
      if (streamId.current || activeRewrite.current || pending.current) {
        event.preventDefault();
        event.stopPropagation();
        if (streamId.current || activeRewrite.current?.previousText != null) {
          cancelRewrite();
        } else discard();
        return;
      }
      if (rootRef.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelRewrite, discard, onClose]);

  /** Replace the selection with the whole proposal, or with `text` built from accepted blocks. */
  const accept = useCallback(
    (text?: string) => {
      const item = pending.current;
      if (!item?.text) return;
      const editor = getEditorView(item.tabId);
      pending.current = null;
      disarmRewriteGate(item.tabId);
      setOffer(false);
      clearRewriteSession();
      const replacement = text ?? item.text;
      if (!editor || !same(item) || !commitRewrite(editor, item.from, item.to, replacement)) {
        clearProposal(item);
        setNote("stale");
        settleEntries(null, "stale");
        return;
      }
      recordAiAcceptance("rewrite");
      setNote("accepted");
      settleEntries(null, "accepted");
    },
    [clearRewriteSession, settleEntries]
  );

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
      accept();
    };
    window.addEventListener("keydown", onTab, true);
    return () => window.removeEventListener("keydown", onTab, true);
  }, [accept]);

  const startEntries = (user: ChatEntry, reply: ChatEntry) => {
    restoredEntries.current = null;
    stickToBottom.current = true;
    setEntries((list) => [...list, user, reply]);
    setNote(null);
    setInstruction("");
    setMentionQuery(null);
    setMenu(null);
  };

  const send = async (prompt?: string) => {
    const selected = span;
    const current = selected?.text ?? "";
    const request = (prompt ?? instruction).trim();
    if (!settings?.baseUrl.trim() || !settings.model.trim()) {
      onNeedSettings();
      return;
    }
    if (!selected || selectionTooLarge(current, limits.selectionChars) || !request) return;
    if (pending.current) discard();
    const ticket = epoch.current;
    const item: PendingRewrite = {
      tabId,
      from: selected.from,
      to: selected.to,
      original: selected.text,
      text: "",
      onAccept: () => accept(),
      onDiscard: () => discard(),
    };
    const lines = selectionLines(tabId, selected);
    const replyId = newChatId();
    startEntries(
      {
        id: newChatId(),
        role: "user",
        mode: "rewrite",
        text: request,
        chips: [
          {
            kind: "selection",
            label: lines
              ? lines[0] === lines[1]
                ? t("ai.panel.selectionLine", { line: lines[0] })
                : t("ai.panel.selectionLines", { from: lines[0], to: lines[1] })
              : t("ai.context.selection"),
          },
        ],
      },
      {
        id: replyId,
        role: "rewrite",
        model: settings.model,
        original: selected.text,
        text: "",
        status: "live",
      }
    );
    liveEntryId.current = replyId;
    pendingEntryId.current = null;
    pending.current = item;
    armRewriteGate(tabId, () => discard());
    paint(item);
    clearRewriteSession();
    setOffer(false);
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
      if (ticket !== epoch.current) return;
      const baseMessages = assembleRewrite(
        current,
        instructionWithoutMentions(request) || request,
        tab
          ? {
              filename: tab.name,
              document,
              from: selected.from,
              to: selected.to,
            }
          : null,
        { exclude: excluded, references, extraBudget: limits.contextChars }
      ).messages;
      const maxTokens = replyTokens(
        messageTokens(baseMessages),
        limits.rewriteMaxTokens,
        settings.contextTokens
      );
      const session: RewriteSession = { baseMessages, turns: [] };
      sessionRef.current = session;
      setRewriteSession(session);
      const metric: RewriteMetric = {
        startedAt: metricNow(),
        firstToken: false,
        settled: false,
        offered: false,
      };
      activeRewrite.current = {
        instruction: request,
        previousText: null,
        replacedPrevious: false,
        metric,
      };
      recordAiRequest("rewrite");
      const id = await aiStart({
        providerId: "openai-compatible",
        baseUrl: settings.baseUrl,
        model: settings.model,
        profileId: settings.id,
        maxTokens,
        messages: baseMessages,
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
      if (ticket !== epoch.current) return;
      settleRewriteMetric("failed");
      activeRewrite.current = null;
      const failed = pending.current;
      pending.current = null;
      if (failed) {
        disarmRewriteGate(failed.tabId);
        clearProposal(failed);
      }
      clearRewriteSession();
      const message = error instanceof Error ? error.message : String(error);
      show(reduceStream(viewRef.current, { type: "error", message }));
      settleEntries("failed", null, failureText(error));
    }
  };

  const continueRewrite = async () => {
    const request = instruction.trim();
    const item = pending.current;
    const session = sessionRef.current;
    if (!item?.text || !session || !offer || !request) return;
    if (!settings?.baseUrl.trim() || !settings.model.trim()) {
      onNeedSettings();
      return;
    }
    const ticket = epoch.current;
    const metric: RewriteMetric = {
      startedAt: metricNow(),
      firstToken: false,
      settled: false,
      offered: false,
    };
    activeRewrite.current = {
      instruction: request,
      previousText: item.text,
      replacedPrevious: false,
      metric,
    };
    const replyId = newChatId();
    startEntries(
      { id: newChatId(), role: "user", mode: "rewrite", text: request, chips: [] },
      {
        id: replyId,
        role: "rewrite",
        model: settings.model,
        original: item.original,
        text: "",
        status: "live",
      }
    );
    liveEntryId.current = replyId;
    recordAiRequest("rewrite");
    setOffer(false);
    streamId.current = null;
    followThinking.current = true;
    show(reduceStream(IDLE_STREAM, { type: "start" }));
    try {
      const tab = useWorkspace.getState().tabs.find((candidate) => candidate.id === tabId);
      const document = tab ? readBuffer(tab.id, tab.content) : readBuffer(tabId, "");
      const references = await buildReferences(
        parseMentions(request),
        document,
        listedFiles,
        workspaceRoot,
        readFile
      );
      if (ticket !== epoch.current) return;
      const messages = followupFor(
        session,
        item.text,
        instructionWithoutMentions(request) || request,
        references,
        limits,
        settings.contextTokens
      );
      const id = await aiStart({
        providerId: "openai-compatible",
        baseUrl: settings.baseUrl,
        model: settings.model,
        profileId: settings.id,
        maxTokens: replyTokens(
          messageTokens(messages),
          limits.rewriteMaxTokens,
          settings.contextTokens
        ),
        messages,
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
      if (ticket !== epoch.current) return;
      settleRewriteMetric("failed");
      restorePreviousProposal();
      activeRewrite.current = null;
      const message = error instanceof Error ? error.message : String(error);
      show(reduceStream(viewRef.current, { type: "error", message }));
      settleEntries("failed", null, failureText(error));
    }
  };

  const askWorkspace = async () => {
    const request = instruction.trim();
    if (!workspaceRoot || !request || asking) return;
    if (!settings?.baseUrl.trim() || !settings.model.trim()) {
      onNeedSettings();
      return;
    }
    const controller = new AbortController();
    askAbort.current = controller;
    const denylist = loadDenylist();
    const history = askHistory(askedPairs(entries), limits.historyTurns, limits.historyChars);
    const replyId = newChatId();
    const startedAt = metricNow();
    startEntries(
      { id: newChatId(), role: "user", mode: "ask", text: request, chips: [] },
      {
        id: replyId,
        role: "ask",
        model: settings.model,
        answer: "",
        trace: [],
        sent: 0,
        status: "live",
      }
    );
    setAsking(true);
    setAgentTrace([]);
    setAgentSent(0);
    try {
      const result = await runReadAgent({
        question: request,
        root: workspaceRoot,
        tools: workspaceAgentTools(workspaceRoot, denylist),
        denylist,
        maxSteps: limits.askSteps,
        budget: limits.askBudget,
        readLines: limits.askReadLines,
        resultChars: limits.askResultChars,
        maxTokens: limits.askMaxTokens,
        contextTokens: settings.contextTokens,
        history,
        signal: controller.signal,
        onProgress: (progress) => {
          setAgentTrace(progress.trace);
          setAgentSent(progress.sent);
        },
        complete: (messages, signal, maxTokens) =>
          completeAgentTurn({
            baseUrl: settings.baseUrl,
            model: settings.model,
            profileId: settings.id,
            messages,
            maxTokens,
            signal,
          }),
      });
      patchEntry(replyId, {
        answer: result.answer,
        trace: result.trace.map(({ name, detail }) => ({ name, detail })),
        sent: result.sent,
        status: result.stop === "cancelled" ? "cancelled" : "done",
        elapsedMs: metricNow() - startedAt,
      });
    } catch (error) {
      patchEntry(replyId, {
        answer: localizeError(error),
        status: "failed",
        elapsedMs: metricNow() - startedAt,
      });
    } finally {
      if (askAbort.current === controller) askAbort.current = null;
      setAsking(false);
      setAgentTrace([]);
      setAgentSent(0);
    }
  };

  const cancelAsk = () => {
    askAbort.current?.abort();
  };

  const convertAnswerToRewrite = (answer: string) => {
    setMode("rewrite");
    setInstruction(t("ai.answer.rewriteSeed", { answer }));
    inputRef.current?.focus();
  };

  /** Start over. The finished conversation stays in history. */
  const reset = (next: { id: string; entries: ChatEntry[] }) => {
    askAbort.current?.abort();
    discard();
    setThinkingById({});
    restoredEntries.current = next.entries.length > 0 ? next.entries : null;
    stickToBottom.current = true;
    setConversationId(next.id);
    setEntries(next.entries);
    setOpenProcess([]);
    setNote(null);
    setInstruction("");
    setMentionQuery(null);
    setMenu(null);
    show(IDLE_STREAM);
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

  const pickMention = (token: string) => {
    if (mentionQuery === null) return;
    const next = insertMention(instruction, mentionCaret, mentionQuery, token);
    setInstruction(next.text);
    setMentionQuery(null);
    inputRef.current?.focus();
  };

  const onMentionClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const token = event.currentTarget.dataset.token;
    if (token) pickMention(token);
  };

  const insertAt = () => {
    const node = inputRef.current;
    const caret = node?.selectionStart ?? instruction.length;
    const prefix = caret > 0 && !/\s/.test(instruction[caret - 1] ?? "") ? " @" : "@";
    const next = instruction.slice(0, caret) + prefix + instruction.slice(caret);
    const at = caret + prefix.length;
    setInstruction(next);
    setMentionCaret(at);
    setMentionQuery(activeMentionQuery(next, at));
    requestAnimationFrame(() => {
      node?.focus();
      node?.setSelectionRange(at, at);
    });
  };

  const busy = mode === "ask" ? asking : running;
  const canSend =
    mode === "ask"
      ? Boolean(workspaceRoot && instruction.trim()) && !running
      : offer
        ? Boolean(instruction.trim())
        : Boolean(span && !spanTooLarge && instruction.trim()) && !asking;
  const submit = () => {
    if (busy) {
      if (mode === "ask") cancelAsk();
      else cancelRewrite();
      return;
    }
    if (!canSend) return;
    if (mode === "ask") void askWorkspace();
    else if (offer) void continueRewrite();
    else void send();
  };

  const noteText =
    note === "accepted"
      ? t("ai.stream.accepted")
      : note === "restored"
        ? t("ai.stream.restored")
        : note === "followupRestored"
          ? t("ai.stream.followupRestored")
          : note === "stale"
            ? t("ai.stream.stale")
            : null;

  const local = isLocalHost(host);
  const footer =
    mode === "rewrite"
      ? !span && !offer
        ? t("ai.stream.selectionEmpty")
        : spanTooLarge && !offer
          ? t("ai.stream.tooLarge")
          : count > 0
            ? t("ai.panel.budget", { count, host })
            : host
              ? t("ai.panel.target", { host })
              : null
      : !workspaceRoot
        ? t("ai.mode.needWorkspace")
        : asking || agentSent > 0
          ? t("ai.mode.askSending", { count: agentSent, budget: limits.askBudget, host })
          : t("ai.mode.askBudget", { budget: limits.askBudget, host });

  const toggleProcess = (id: string) =>
    setOpenProcess((list) =>
      list.includes(id) ? list.filter((item) => item !== id) : [...list, id]
    );

  let version = 0;
  const renderEntry = (entry: ChatEntry) => {
    if (entry.role === "user") return <UserBubble key={entry.id} entry={entry} />;
    if (entry.role === "rewrite") {
      version += 1;
      const live = entry.status === "live";
      const thinking = live ? view.thinking : thinkingById[entry.id];
      const label = live
        ? view.phase === "waiting"
          ? t("ai.stream.waiting")
          : t("ai.panel.generating")
        : [
            entry.status === "cancelled"
              ? t("ai.panel.status.cancelled")
              : entry.status === "failed"
                ? t("ai.panel.status.failed")
                : t("ai.panel.done"),
            entry.elapsedMs !== undefined
              ? t("ai.panel.seconds", { value: seconds(entry.elapsedMs) })
              : "",
            entry.usage
              ? t("ai.panel.tokens", {
                  prompt: entry.usage.promptTokens,
                  completion: entry.usage.completionTokens,
                })
              : "",
          ]
            .filter(Boolean)
            .join(" · ");
      return (
        <div key={entry.id} className="ai-stream__bot">
          <BotHeader model={entry.model} />
          <ProcessRow
            label={label}
            live={live}
            open={openProcess.includes(entry.id)}
            onToggle={() => toggleProcess(entry.id)}
          >
            {thinking ? (
              <pre
                className="ai-stream__thinking"
                ref={live ? thinkingRef : undefined}
                onScroll={(event) => {
                  if (!live) return;
                  const node = event.currentTarget;
                  followThinking.current =
                    node.scrollHeight - node.scrollTop - node.clientHeight < 48;
                }}
              >
                {thinking}
              </pre>
            ) : null}
          </ProcessRow>
          <RewriteCard
            entry={entry}
            version={version}
            liveText={live ? view.text : undefined}
            onAccept={(text) => accept(text)}
            onDiscard={discard}
          />
          {!live && entry.text && (
            <div className="ai-stream__reply-actions">
              <CopyAction text={entry.text} />
            </div>
          )}
        </div>
      );
    }
    const live = entry.status === "live";
    const steps = live ? agentTrace.map(({ name, detail }) => ({ name, detail })) : entry.trace;
    const label = live
      ? t("ai.panel.asking", {
          step: Math.min(agentTrace.length + 1, limits.askSteps),
          max: limits.askSteps,
          count: agentSent,
          budget: limits.askBudget,
        })
      : [
          entry.status === "cancelled"
            ? t("ai.panel.status.cancelled")
            : entry.status === "failed"
              ? t("ai.panel.status.failed")
              : t("ai.panel.looked", { count: entry.trace.length }),
          entry.elapsedMs !== undefined
            ? t("ai.panel.seconds", { value: seconds(entry.elapsedMs) })
            : "",
          entry.sent > 0 ? t("ai.panel.sent", { count: entry.sent }) : "",
        ]
          .filter(Boolean)
          .join(" · ");
    return (
      <div key={entry.id} className="ai-stream__bot">
        <BotHeader model={entry.model} />
        <ProcessRow
          label={label}
          live={live}
          open={live || openProcess.includes(entry.id)}
          onToggle={() => toggleProcess(entry.id)}
        >
          {steps.length > 0 || live ? <TraceList steps={steps} live={live} /> : null}
        </ProcessRow>
        {!live && entry.answer && (
          <AgentAnswer
            answer={entry.answer}
            workspaceRoot={workspaceRoot}
            onOpenMatch={onOpenMatch}
            onInsert={() => insertTextAtSelection(tabId, entry.answer)}
            onConvertToRewrite={() => convertAnswerToRewrite(entry.answer)}
          />
        )}
      </div>
    );
  };

  const showQuick = mode === "rewrite" && span && !spanTooLarge && !running && !offer && !asking;
  const showContext = mode === "rewrite" && span && !spanTooLarge && contextParts.length > 0;
  const lines = span ? selectionLines(tabId, span) : null;

  return (
    <section
      className="ai-stream"
      ref={rootRef}
      aria-label={t("menu.aiPanel")}
      style={{ flexBasis: panelWidth }}
    >
      <div className="ai-stream__head">
        <strong className="ai-stream__title">{t("ai.panel.title")}</strong>
        <div className="ai-stream__modes" role="radiogroup" aria-label={t("ai.mode.label")}>
          {(["rewrite", "ask"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="radio"
              aria-checked={mode === item}
              className={`ai-stream__mode${mode === item ? " is-on" : ""}`}
              onClick={() => setMode(item)}
            >
              {t(`ai.mode.${item}`)}
            </button>
          ))}
        </div>
        <span className="ai-stream__spacer" />
        <span className="ai-stream__menu-anchor">
          <button
            type="button"
            className={`ai-stream__icon${menu === "history" ? " is-on" : ""}`}
            aria-label={t("ai.panel.history")}
            aria-expanded={menu === "history"}
            data-tip={menu === "history" ? undefined : t("ai.panel.history")}
            onClick={() => {
              if (menu === "history") {
                setMenu(null);
                return;
              }
              setHistory(loadHistory());
              setMenu("history");
            }}
          >
            <PanelIcon kind="history" />
          </button>
          {menu === "history" && (
            <HistoryList
              items={history}
              currentId={conversationId}
              disabled={running || asking}
              onOpen={(item) => reset({ id: item.id, entries: restoreEntries(item) })}
              onRemove={(id) => {
                setHistory(removeConversation(id));
                if (id === conversationId) reset({ id: newChatId(), entries: [] });
              }}
              onClear={() => {
                clearHistory();
                setHistory([]);
              }}
            />
          )}
        </span>
        <button
          type="button"
          className="ai-stream__icon"
          aria-label={t("ai.panel.newChat")}
          data-tip={t("ai.panel.newChat")}
          disabled={entries.length === 0 && !running && !asking}
          onClick={() => reset({ id: newChatId(), entries: [] })}
        >
          <PanelIcon kind="newChat" />
        </button>
        <button
          type="button"
          className="ai-stream__icon"
          aria-label={t("ai.panel.close")}
          data-tip={t("ai.panel.close")}
          onClick={onClose}
        >
          <PanelIcon kind="close" />
        </button>
      </div>

      <div
        className="ai-stream__timeline"
        ref={listRef}
        aria-live="polite"
        onScroll={(event) => {
          const node = event.currentTarget;
          const near = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
          stickToBottom.current = near;
          setAtBottom(near);
        }}
      >
        {entries.length === 0 ? (
          <div className="ai-stream__empty">
            <AppLogo className="ai-stream__empty-logo" />
            <h3>{t(mode === "ask" ? "ai.panel.emptyAsk" : "ai.panel.emptyRewrite")}</h3>
            <p>
              {mode === "ask"
                ? workspaceRoot
                  ? t("ai.mode.askHint")
                  : t("ai.mode.needWorkspace")
                : t(sourceShown ? "ai.panel.emptyRewriteHint" : "ai.panel.emptyRewriteHintPreview")}
            </p>
          </div>
        ) : (
          entries.map(renderEntry)
        )}
        {noteText && <p className="ai-stream__status">{noteText}</p>}
      </div>
      {!atBottom && entries.length > 0 && (
        <button
          type="button"
          className="ai-stream__jump"
          aria-label={t("ai.panel.jump")}
          title={t("ai.panel.jump")}
          onClick={() => {
            const node = listRef.current;
            if (!node) return;
            stickToBottom.current = true;
            node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
          }}
        >
          <PanelIcon kind="down" size={14} />
        </button>
      )}

      <div className="ai-stream__foot">
        {showQuick && (
          <div className="ai-stream__quick" role="group" aria-label={t("ai.stream.actions")}>
            {QUICK_ACTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="ai-stream__pill"
                title={t(item.promptKey)}
                onClick={() => void send(t(item.promptKey))}
              >
                {t(item.labelKey)}
              </button>
            ))}
          </div>
        )}
        <div className="ai-stream__composer">
          {mode === "rewrite" && span && !offer && (
            <div className="ai-stream__composer-ctx">
              <span className="ai-stream__chip" title={selectionExcerpt(span.text)}>
                <PanelIcon kind="text" size={12} />
                <span>
                  {lines
                    ? lines[0] === lines[1]
                      ? t("ai.panel.selectionLine", { line: lines[0] })
                      : t("ai.panel.selectionLines", { from: lines[0], to: lines[1] })
                    : t("ai.context.selection")}
                </span>
                <button
                  type="button"
                  aria-label={t("ai.stream.removeSelection")}
                  disabled={running}
                  onClick={() => {
                    dismissedSelection.current = selectionKey(span);
                    setSpan(null);
                  }}
                >
                  <PanelIcon kind="close" size={10} />
                </button>
              </span>
            </div>
          )}
          <textarea
            ref={inputRef}
            className="ai-stream__input"
            rows={2}
            value={instruction}
            aria-label={t("ai.stream.instruction")}
            placeholder={
              mode === "ask"
                ? t("ai.mode.askPlaceholder")
                : offer
                  ? t("ai.stream.followupPlaceholder")
                  : t("ai.panel.placeholder")
            }
            onChange={(event) => {
              const value = event.target.value;
              const caret = event.target.selectionStart ?? value.length;
              setInstruction(value);
              setMentionCaret(caret);
              setMentionQuery(activeMentionQuery(value, caret));
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (mentionQuery !== null && mentionChoices.length > 0) {
                pickMention(mentionChoices[0].token);
                return;
              }
              if (!busy) submit();
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
                      aria-selected={false}
                      className="ai-stream__mention"
                      onMouseDown={(event) => event.preventDefault()}
                      data-token={choice.token}
                      onClick={onMentionClick}
                    >
                      <span>{choice.label}</span>
                      <span className="ai-stream__mention-detail">{choice.detail}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
          <div className="ai-stream__bar">
            <button
              type="button"
              className="ai-stream__icon ai-stream__icon--up"
              aria-label={t("ai.panel.at")}
              data-tip={t("ai.panel.at")}
              onClick={insertAt}
            >
              <PanelIcon kind="at" />
            </button>
            {showContext && (
              <span className="ai-stream__menu-anchor">
                <button
                  type="button"
                  className={`ai-stream__icon ai-stream__icon--up${
                    menu === "context" ? " is-on" : ""
                  }`}
                  aria-label={t("ai.context.list")}
                  aria-expanded={menu === "context"}
                  data-tip={menu === "context" ? undefined : t("ai.context.list")}
                  disabled={running || offer}
                  onClick={() => setMenu(menu === "context" ? null : "context")}
                >
                  <PanelIcon kind="layers" />
                </button>
                {menu === "context" && (
                  <div
                    className="ai-stream__popover ai-stream__popover--up"
                    role="group"
                    aria-label={t("ai.context.list")}
                  >
                    <div className="ai-stream__popover-title">
                      <span>{t("ai.context.list")}</span>
                    </div>
                    {contextParts.map((part) => (
                      <label key={part.id} className="ai-stream__check">
                        <input
                          type="checkbox"
                          checked={part.included}
                          disabled={part.id === "selection"}
                          onChange={() => {
                            if (part.id === "selection") return;
                            setExcluded((current) =>
                              current.includes(part.id)
                                ? current.filter((item) => item !== part.id)
                                : [...current, part.id]
                            );
                          }}
                        />
                        <span>{t(PART_LABEL[part.id])}</span>
                        {part.dropped && <small>{t("ai.context.dropped")}</small>}
                      </label>
                    ))}
                  </div>
                )}
              </span>
            )}
            <span className="ai-stream__spacer" />
            <label className="ai-stream__model" title={currentChoice?.label}>
              <span className="sr-only">{t("ai.models")}</span>
              <select
                value={currentChoice ? modelValue : ""}
                aria-label={t("ai.models")}
                disabled={running || asking || modelChoices.length === 0}
                onChange={(event) => switchModel(event.target.value)}
              >
                {modelChoices.length === 0 && <option value="">{t("ai.stream.modelEmpty")}</option>}
                {modelChoices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
              <span className="ai-stream__model-name" aria-hidden="true">
                {currentChoice?.short ?? t("ai.stream.modelEmpty")}
              </span>
              <PanelIcon kind="chevron" size={11} />
            </label>
            <button
              type="button"
              className={`ai-stream__send${busy ? " is-stop" : ""}`}
              aria-label={busy ? t("ai.panel.stop") : t("ai.panel.send")}
              title={busy ? t("ai.panel.stop") : t("ai.panel.send")}
              disabled={!busy && !canSend}
              onClick={submit}
            >
              <PanelIcon kind={busy ? "stop" : "send"} size={14} />
            </button>
          </div>
        </div>
        {footer && (
          <p className="ai-stream__meta">
            {host && <span className={`ai-stream__dot${local ? " is-local" : ""}`} />}
            <span>{footer}</span>
          </p>
        )}
      </div>
    </section>
  );
}
