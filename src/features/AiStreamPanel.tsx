import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  getEditorView,
  getSelectionSpan,
  insertTextAtSelection,
  readBuffer,
  subscribeDocChanges,
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
  REWRITE_MAX_TOKENS,
  selectionTooLarge,
  type QuickActionId,
  type StreamView,
} from "./aiStream";
import { isMarkdownFile } from "./markdown";
import { extractHeadings } from "./outline";
import { assembleRewrite, type ContextPartId } from "./rewriteContext";
import {
  appendRewriteTurn,
  followupRewriteMessages,
  type RewriteTurn,
} from "./rewriteConversation";
import { loadDenylist } from "./agentAccess";
import { AGENT_SEND_BUDGET, runReadAgent, type AgentTrace } from "./readAgent";
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
}: Props) {
  const { t } = useI18n();
  const [instruction, setInstruction] = useState("");
  const [catalog, setCatalog] = useState<AiCatalog>(loadAiSettings);
  const [mode, setMode] = useState<"rewrite" | "ask">("rewrite");
  const [asking, setAsking] = useState(false);
  const [agentAnswer, setAgentAnswer] = useState<string | null>(null);
  const [agentTrace, setAgentTrace] = useState<AgentTrace[]>([]);
  const [agentSent, setAgentSent] = useState(0);
  const [action, setAction] = useState<QuickActionId | null>(null);
  const [view, setView] = useState<StreamView>(IDLE_STREAM);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [offer, setOffer] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [rewriteSession, setRewriteSession] = useState<RewriteSession | null>(null);
  const [proposal, setProposal] = useState("");
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
  const settings = activeModel(catalog);
  const host = modelHost(settings?.baseUrl ?? "");
  const running = view.phase === "waiting" || view.phase === "streaming";
  const modelValue = `${catalog.activeProviderId}|${catalog.activeModelId}`;
  const modelChoices = catalog.providers.flatMap((provider) =>
    provider.models
      .filter((model) => model.enabled || `${provider.id}|${model.id}` === modelValue)
      .map((model) => ({
        value: `${provider.id}|${model.id}`,
        label: `${provider.name || provider.baseUrl || "服务商"} · ${model.name || model.model}`,
      }))
  );
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
        }
      )
    : null;
  const rewriteTurns = rewriteSession?.turns ?? [];
  const followupPreview =
    offer && rewriteSession && proposal && instruction.trim()
      ? followupRewriteMessages(
          rewriteSession.baseMessages,
          proposal,
          instructionWithoutMentions(instruction) || instruction.trim(),
          parseMentions(instruction).length === 0 ? "" : referenceText
        )
      : null;
  const messages = followupPreview ?? (assembled && instruction.trim() ? assembled.messages : []);
  const count = outgoingChars(messages);
  const contextParts = (assembled?.parts ?? []).filter((part) => part.available);

  const show = useCallback((next: StreamView) => {
    viewRef.current = next;
    setView(next);
  }, []);

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

  const paint = useCallback(
    (item: PendingRewrite) => {
      const editor = getEditorView(item.tabId);
      if (!editor || !same(item)) {
        pending.current = null;
        disarmRewriteGate(item.tabId);
        setOffer(false);
        setNote("stale");
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
    [t]
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
      pending.current = null;
      disarmRewriteGate(item.tabId);
      setOffer(false);
      setNote("stale");
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
    if (event.kind === "done") {
      settleRewriteMetric("success", event.usage);
      setUsage(event.usage ?? null);
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
        setInstruction("");
        setAction(null);
      } else if (request?.previousText != null && restorePreviousProposal()) {
        activeRewrite.current = null;
        return;
      }
    } else {
      settleRewriteMetric("failed");
      if (restorePreviousProposal()) {
        activeRewrite.current = null;
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
  }, [clearRewriteSession, settleRewriteMetric]);
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
    setUsage(null);
    if (restored) {
      const next = reduceStream(viewRef.current, { type: "cancel" });
      viewRef.current = next;
      setView(next);
    } else {
      discard();
    }
    if (id) void aiCancel(id).catch(() => {});
  }, [discard, restorePreviousProposal, settleRewriteMetric]);

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

  const accept = useCallback(() => {
    const item = pending.current;
    if (!item?.text) return;
    const editor = getEditorView(item.tabId);
    pending.current = null;
    disarmRewriteGate(item.tabId);
    setOffer(false);
    setAction(null);
    clearRewriteSession();
    if (!editor || !same(item) || !commitRewrite(editor, item.from, item.to, item.text)) {
      clearProposal(item);
      setNote("stale");
      return;
    }
    recordAiAcceptance("rewrite");
    setNote("accepted");
  }, [clearRewriteSession]);

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

  const send = async (prompt?: string) => {
    const selected = span;
    const current = selected?.text ?? "";
    const request = (prompt ?? instruction).trim();
    if (!settings?.baseUrl.trim() || !settings.model.trim()) {
      onNeedSettings();
      return;
    }
    if (!selected || selectionTooLarge(current) || !request) return;
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
    pending.current = item;
    armRewriteGate(tabId, () => discard());
    paint(item);
    clearRewriteSession();
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
        { exclude: excluded, references }
      ).messages;
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
        maxTokens: REWRITE_MAX_TOKENS,
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
    recordAiRequest("rewrite");
    setOffer(false);
    setNote(null);
    setUsage(null);
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
      const id = await aiStart({
        providerId: "openai-compatible",
        baseUrl: settings.baseUrl,
        model: settings.model,
        profileId: settings.id,
        maxTokens: REWRITE_MAX_TOKENS,
        messages: followupRewriteMessages(
          session.baseMessages,
          item.text,
          instructionWithoutMentions(request) || request,
          references
        ),
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
    setAsking(true);
    setAgentAnswer(null);
    setAgentTrace([]);
    setAgentSent(0);
    try {
      const result = await runReadAgent({
        question: request,
        root: workspaceRoot,
        tools: workspaceAgentTools(workspaceRoot, denylist),
        denylist,
        signal: controller.signal,
        onProgress: (progress) => {
          setAgentTrace(progress.trace);
          setAgentSent(progress.sent);
        },
        complete: (messages, signal) =>
          completeAgentTurn({
            baseUrl: settings.baseUrl,
            model: settings.model,
            profileId: settings.id,
            messages,
            signal,
          }),
      });
      setAgentAnswer(result.answer);
      setAgentTrace(result.trace);
      setAgentSent(result.sent);
    } catch (error) {
      setAgentAnswer(localizeError(error));
    } finally {
      if (askAbort.current === controller) askAbort.current = null;
      setAsking(false);
    }
  };

  const cancelAsk = () => {
    askAbort.current?.abort();
  };

  const insertAgentAnswer = () => {
    if (!agentAnswer) return;
    insertTextAtSelection(tabId, agentAnswer);
  };

  const convertAgentAnswerToRewrite = () => {
    if (!agentAnswer) return;
    setMode("rewrite");
    setInstruction(t("ai.answer.rewriteSeed", { answer: agentAnswer }));
    setAction(null);
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
        : note === "followupRestored"
          ? t("ai.stream.followupRestored")
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
    <section
      className="ai-stream"
      ref={rootRef}
      aria-label={t("ai.stream.title")}
      style={{ flexBasis: panelWidth }}
    >
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
        <label className="ai-stream__model-picker">
          <span className="sr-only">{t("ai.models")}</span>
          <select
            value={modelChoices.some((choice) => choice.value === modelValue) ? modelValue : ""}
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
        </label>
        <span className="ai-stream__host" title={host}>
          {host}
        </span>
        <button type="button" className="ai-stream__close" onClick={onClose}>
          {t("ai.stream.close")}
        </button>
      </div>
      <div className="ai-stream__body">
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
                    disabled={running || offer || !span || selectionTooLarge(span.text)}
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
              <span>
                {t(
                  rewriteTurns.length > 0
                    ? "ai.stream.followupInstruction"
                    : "ai.stream.instruction"
                )}
              </span>
              <div className="ai-stream__composer">
                {mode === "rewrite" && span && (
                  <span
                    className="ai-stream__selection-chip"
                    title={span.text}
                    aria-label={`${t("ai.context.selection")}: ${selectionExcerpt(span.text)}`}
                  >
                    <span className="ai-stream__selection-chip-label">
                      {t("ai.context.selection")}
                    </span>
                    <span className="ai-stream__selection-chip-text">
                      {selectionExcerpt(span.text)}
                    </span>
                    <button
                      type="button"
                      aria-label={t("ai.stream.removeSelection")}
                      disabled={running || offer}
                      onClick={() => {
                        dismissedSelection.current = selectionKey(span);
                        setSpan(null);
                      }}
                    >
                      ×
                    </button>
                  </span>
                )}
                <textarea
                  className="ai-stream__input"
                  rows={3}
                  value={instruction}
                  placeholder={
                    mode === "ask"
                      ? t("ai.mode.askPlaceholder")
                      : rewriteTurns.length > 0
                        ? t("ai.stream.followupPlaceholder")
                        : t("ai.stream.placeholder")
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
              </div>
              {mentionQuery !== null && (
                <ul
                  className="ai-stream__mentions"
                  role="listbox"
                  aria-label={t("ai.mention.list")}
                >
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
              {mode === "rewrite" && !span && <span>{t("ai.stream.selectionEmpty")}</span>}
              {mode === "rewrite" && span && selectionTooLarge(span.text) && (
                <span>{t("ai.stream.tooLarge")}</span>
              )}
              {mode === "rewrite" && count > 0 && span && !selectionTooLarge(span.text) && (
                <span>{t("ai.stream.budget", { count, host })}</span>
              )}
              {mode === "ask" && workspaceRoot && agentSent === 0 && !asking && (
                <span>{t("ai.mode.askBudget", { budget: AGENT_SEND_BUDGET, host })}</span>
              )}
              {mode === "ask" && agentSent > 0 && (
                <span>
                  {t(asking ? "ai.mode.askSending" : "ai.mode.askSent", {
                    count: agentSent,
                    budget: AGENT_SEND_BUDGET,
                    host,
                  })}
                </span>
              )}
            </div>
            {mode === "rewrite" &&
              span &&
              !selectionTooLarge(span.text) &&
              contextParts.length > 0 && (
                <div className="ai-stream__context" role="group" aria-label={t("ai.context.list")}>
                  {contextParts.map((part) => (
                    <button
                      key={part.id}
                      type="button"
                      className={`ai-stream__chip${part.included ? " is-on" : ""}`}
                      aria-pressed={part.included}
                      disabled={running || offer || part.id === "selection"}
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
              {mode === "ask" && asking ? (
                <button type="button" className="btn" onClick={cancelAsk}>
                  {t("ai.mode.askCancel")}
                </button>
              ) : mode === "ask" ? (
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={running || !workspaceRoot || !instruction.trim()}
                  onClick={() => void askWorkspace()}
                >
                  {t("ai.mode.askSend")}
                </button>
              ) : running ? (
                <button type="button" className="btn" onClick={cancelRewrite}>
                  {t("ai.stream.cancel")}
                </button>
              ) : offer ? (
                <>
                  <button type="button" className="btn btn--primary" onClick={accept}>
                    {t("ai.stream.acceptAll")}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={!instruction.trim()}
                    onClick={() => void continueRewrite()}
                  >
                    {t("ai.stream.followup")}
                  </button>
                  <button type="button" className="btn" onClick={discard}>
                    {t("ai.stream.discard")}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={!span || selectionTooLarge(span.text) || !instruction.trim()}
                  onClick={() => {
                    setAction(null);
                    void send();
                  }}
                >
                  {t("ai.stream.send")}
                </button>
              )}
            </div>
            <div className="ai-stream__conversation" aria-live="polite">
              {mode === "ask" && !workspaceRoot && (
                <p className="ai-stream__status">{t("ai.mode.needWorkspace")}</p>
              )}
              {mode === "rewrite" && rewriteTurns.length > 0 && (
                <ol className="ai-stream__history" aria-label={t("ai.stream.history")}>
                  {rewriteTurns.map((turn, index) => (
                    <li key={`${index}-${turn.instruction}`}>
                      <strong>{t("ai.stream.historyTurn", { count: index + 1 })}</strong>
                      <span>{turn.instruction}</span>
                      <small>{turn.proposal.slice(0, 180)}</small>
                    </li>
                  ))}
                </ol>
              )}
              {mode === "ask" && agentTrace.length > 0 && (
                <details className="ai-stream__agent-event">
                  <summary>{t("ai.stream.toolCalls", { count: agentTrace.length })}</summary>
                  <ol className="ai-stream__trace">
                    {agentTrace.map((step, index) => (
                      <li key={`${step.name}-${index}`}>
                        <strong>{step.name}</strong>
                        {step.detail ? <span>{step.detail}</span> : null}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
              {mode === "ask" && agentAnswer && (
                <AgentAnswer
                  answer={agentAnswer}
                  workspaceRoot={workspaceRoot}
                  onOpenMatch={onOpenMatch}
                  onInsert={insertAgentAnswer}
                  onConvertToRewrite={convertAgentAnswerToRewrite}
                />
              )}
              {status && <p className="ai-stream__status">{status}</p>}
              {usage && (
                <p className="ai-stream__status">
                  {t("ai.stream.usage", {
                    prompt: usage.promptTokens,
                    completion: usage.completionTokens,
                  })}
                </p>
              )}
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
                    followThinking.current =
                      node.scrollHeight - node.scrollTop - node.clientHeight < 48;
                  }}
                >
                  {view.thinking || t("ai.stream.thinkingEmpty")}
                </pre>
              </details>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
