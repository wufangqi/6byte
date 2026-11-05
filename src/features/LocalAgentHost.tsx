import { useEffect, useRef } from "react";
import type { EditorView } from "@codemirror/view";
import { getEditorView, subscribeDocChanges, subscribeSelectionChanges } from "../editor/registry";
import { clearRewritePreview, commitRewrite, showRewritePreview } from "../editor/rewritePreview";
import { useI18n } from "../i18n";
import {
  isTauri,
  onLocalAgentCandidate,
  onLocalAgentOpen,
  resolveLocalAgentCandidate,
} from "../ipc/api";
import { samePath } from "../lib/paths";
import { selectActiveTab, useWorkspace } from "../stores/workspace";
import { useFileTree } from "../stores/fileTree";
import { placeCandidate, RevisionLog } from "./agentRevision";
import {
  enableLocalAgent,
  localAgentPreferred,
  publishEditor,
  subscribeLocalAgent,
  syncLocalAgentGate,
} from "./localAgent";

interface ShownCandidate {
  tabId: string;
  path: string;
  revision: number;
  from: number;
  to: number;
  text: string;
}

interface AgentCopy {
  stale: string;
  wrongFile: string;
  original: string;
  proposal: string;
  accept: string;
  discard: string;
}

/**
 * Keeps the loopback agent in step with the editor.
 *
 * A candidate carries the revision the agent read. Typing outside that range
 * moves it; typing inside drops it. Accept is what writes the text.
 */
export default function LocalAgentHost({
  onOpenDocument,
}: {
  onOpenDocument?: (path: string) => void;
}) {
  const { t } = useI18n();
  const openRef = useRef(onOpenDocument);
  const logs = useRef(new Map<string, RevisionLog>());
  const versions = useRef(new Map<string, number>());
  const shown = useRef<ShownCandidate | null>(null);
  useEffect(() => {
    openRef.current = onOpenDocument;
  }, [onOpenDocument]);

  const copy = useRef<AgentCopy>({
    stale: "",
    wrongFile: "",
    original: "",
    proposal: "",
    accept: "",
    discard: "",
  });

  useEffect(() => {
    if (!isTauri) return;
    let stopDoc = () => {};
    let stopSelection = () => {};
    let timer = 0;
    let alive = true;

    const publish = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const tab = selectActiveTab(useWorkspace.getState());
        const revision = logFor(logs.current, tab?.path ?? "").revision;
        if (!tab || tab.mode !== "text") {
          void publishEditor({
            path: "",
            name: "",
            revision,
            text: "",
            selectionFrom: 0,
            selectionTo: 0,
            selectionText: "",
          });
          return;
        }
        const view = getEditorView(tab.id);
        const selection = view?.state.selection.main;
        const from = selection?.from ?? 0;
        const to = selection?.to ?? 0;
        void publishEditor({
          path: tab.path ?? "",
          name: tab.name,
          revision,
          text: view ? view.state.doc.toString() : tab.content,
          selectionFrom: from,
          selectionTo: to,
          selectionText: view && from !== to ? view.state.sliceDoc(from, to) : "",
        });
      }, 200);
    };

    const followShown = (tabId: string, path: string) => {
      const pending = shown.current;
      if (!pending || !samePath(pending.path, path)) return;
      const view = getEditorView(tabId);
      const decision = view
        ? placeCandidate(
            logFor(logs.current, path),
            pending.revision,
            pending.from,
            pending.to,
            view.state.doc.length
          )
        : { status: "stale" as const, revision: logFor(logs.current, path).revision };
      queueMicrotask(() => {
        const live = getEditorView(tabId);
        if (!live || shown.current !== pending) return;
        if (decision.status === "stale") {
          shown.current = null;
          clearRewritePreview(live);
          useWorkspace.getState().setNotice(copy.current.stale);
          return;
        }
        pending.from = decision.from;
        pending.to = decision.to;
        pending.revision = decision.revision;
        paintCandidate(live, pending, shown, copy.current);
      });
    };

    const bindTab = () => {
      stopDoc();
      stopSelection();
      const tab = selectActiveTab(useWorkspace.getState());
      if (!tab) return;
      stopDoc = subscribeDocChanges(tab.id, (edits) => {
        const path = tab.path ?? "";
        const log = logFor(logs.current, path);
        if (edits.length === 0) log.invalidate();
        else log.note(edits);
        followShown(tab.id, path);
        publish();
      });
      stopSelection = subscribeSelectionChanges(tab.id, publish);
    };

    const start = () => {
      if (!localAgentPreferred()) return;
      void enableLocalAgent().then(() => {
        if (!alive) return;
        const tab = selectActiveTab(useWorkspace.getState());
        logFor(logs.current, tab?.path ?? "").invalidate();
        bindTab();
        publish();
      });
    };

    if (localAgentPreferred()) start();
    const unsubPref = subscribeLocalAgent(() => {
      stopDoc();
      stopSelection();
      if (localAgentPreferred()) start();
    });
    const unsubTree = useFileTree.subscribe(() => {
      void syncLocalAgentGate();
    });
    const onDeny = () => {
      void syncLocalAgentGate();
    };
    window.addEventListener("ainative-agent-deny", onDeny);
    const unsubTabs = useWorkspace.subscribe((state) => {
      if (!localAgentPreferred()) return;
      const tab = selectActiveTab(state);
      if (tab) {
        const previous = versions.current.get(tab.id);
        if (previous !== undefined && previous !== tab.version) {
          logFor(logs.current, tab.path ?? "").invalidate();
        }
        versions.current.set(tab.id, tab.version);
      }
      bindTab();
      publish();
    });

    return () => {
      alive = false;
      window.clearTimeout(timer);
      unsubPref();
      unsubTree();
      unsubTabs();
      window.removeEventListener("ainative-agent-deny", onDeny);
      stopDoc();
      stopSelection();
    };
  }, []);

  useEffect(() => {
    copy.current = {
      stale: t("ai.stream.stale"),
      wrongFile: t("localAgent.wrongFile"),
      original: t("ai.stream.original"),
      proposal: t("ai.stream.proposal"),
      accept: t("ai.stream.acceptAll"),
      discard: t("ai.review.keepOriginal"),
    };
    const pending = shown.current;
    const tab = selectActiveTab(useWorkspace.getState());
    const view = tab ? getEditorView(tab.id) : null;
    if (pending && view && pending.tabId === tab?.id)
      paintCandidate(view, pending, shown, copy.current);

    if (!isTauri) return;
    let stop = () => {};
    let stopOpen = () => {};
    let alive = true;
    void onLocalAgentOpen((request) => {
      openRef.current?.(request.path);
    }).then((unlisten) => {
      if (!alive) unlisten();
      else stopOpen = unlisten;
    });
    void onLocalAgentCandidate((candidate) => {
      let settled = false;
      const finish = (
        status: "offered" | "stale" | "unavailable",
        from: number,
        to: number,
        revision: number
      ) => {
        if (settled) return;
        settled = true;
        void resolveLocalAgentCandidate({ id: candidate.id, status, from, to, revision });
      };
      const tab = selectActiveTab(useWorkspace.getState());
      const view = tab ? getEditorView(tab.id) : null;
      if (!tab || tab.mode !== "text" || !view || !samePath(tab.path ?? "", candidate.path)) {
        if (tab && !samePath(tab.path ?? "", candidate.path)) {
          useWorkspace.getState().setNotice(copy.current.wrongFile);
        }
        finish("unavailable", 0, 0, 0);
        return;
      }
      const decision = placeCandidate(
        logFor(logs.current, tab.path ?? ""),
        candidate.revision,
        candidate.from,
        candidate.to,
        view.state.doc.length
      );
      if (decision.status === "stale") {
        finish("stale", 0, 0, decision.revision);
        useWorkspace.getState().setNotice(copy.current.stale);
        return;
      }
      const next: ShownCandidate = {
        tabId: tab.id,
        path: tab.path ?? "",
        revision: decision.revision,
        from: decision.from,
        to: decision.to,
        text: candidate.text,
      };
      shown.current = next;
      paintCandidate(view, next, shown, copy.current);
      finish("offered", decision.from, decision.to, decision.revision);
    }).then((unlisten) => {
      if (!alive) unlisten();
      else stop = unlisten;
    });
    return () => {
      alive = false;
      stop();
      stopOpen();
    };
  }, [t]);

  return null;
}

function logFor(logs: Map<string, RevisionLog>, path: string): RevisionLog {
  for (const [key, log] of logs) {
    if (samePath(key, path)) return log;
  }
  const created = new RevisionLog();
  logs.set(path, created);
  return created;
}

function paintCandidate(
  view: EditorView,
  shown: ShownCandidate,
  shownRef: { current: ShownCandidate | null },
  copy: AgentCopy
): void {
  showRewritePreview(view, {
    from: shown.from,
    to: shown.to,
    text: shown.text,
    originalLabel: copy.original,
    rewriteLabel: copy.proposal,
    acceptLabel: copy.accept,
    discardLabel: copy.discard,
    onAccept: () => {
      const current = shownRef.current;
      const live = current ? getEditorView(current.tabId) : null;
      if (!current || !live) return;
      shownRef.current = null;
      commitRewrite(live, current.from, current.to, current.text);
    },
    onDiscard: () => {
      const current = shownRef.current;
      shownRef.current = null;
      const live = (current ? getEditorView(current.tabId) : view) ?? view;
      clearRewritePreview(live);
    },
  });
}
