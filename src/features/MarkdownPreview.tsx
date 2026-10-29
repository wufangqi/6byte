import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import {
  getDocText,
  getEditorView,
  getScrollElement,
  selectSourceRange,
  subscribeDocChanges,
} from "../editor/registry";
import { sourceRangeForPreviewSelection } from "./previewSelection";
import { loadImageDataUrl } from "./images";
import { useWorkspace } from "../stores/workspace";
import { enhanceMermaidDiagram } from "./diagramViewport";
import { renderKatexHtml, renderMermaidSvg } from "./diagrams";
import { localizeError, useI18n } from "../i18n";
import { openExternal } from "../ipc/api";
import { isSafeHttpUrl } from "./externalUrl";
import { useResolvedTheme } from "./theme";
import { renderMarkdown } from "./markdown";
import { highlightCode } from "./highlight";
import { extractHeadings, type OutlineItem } from "./outline";
import {
  FULL_PREVIEW_CHARS,
  WINDOW_CHARS,
  previewSlice,
  wholeDocument,
  type PreviewSlice,
} from "./previewWindow";
import { scrollFraction, topForFraction } from "./scrollSync";

interface Props {
  tabId: string;
  name: string;
  /** Directory of the document; resolves `assets/…` image paths. */
  baseDir: string | null;
  onExport(): void;
  /** Markdown opens in preview. `</>` reveals the source beside it. */
  sourceOn?: boolean;
  onToggleSource?: () => void;
  /** Skip editor scroll sync while the source pane is hidden. */
  syncScroll?: boolean;
}

interface RenderedPreview {
  html: string;
  headings: OutlineItem[];
  slice: PreviewSlice;
}

const TARGET_HIGHLIGHT = "ai-target";

/** The block element whose `data-src` range contains `line` (0-based). */
function elementForLine(root: ParentNode, line: number): HTMLElement | null {
  for (const node of root.querySelectorAll<HTMLElement>("[data-src]")) {
    const [start, end] = (node.getAttribute("data-src") ?? "").split(":").map(Number);
    if (line >= start && line < end) return node;
  }
  return null;
}

/**
 * Keep the text picked for AI visible after focus moves to the AI panel, which
 * clears the page selection. Skipped where the CSS Highlight API is missing.
 */
function markTarget(range: Range | null): void {
  if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
  if (range) CSS.highlights.set(TARGET_HIGHLIGHT, new Highlight(range));
  else CSS.highlights.delete(TARGET_HIGHLIGHT);
}

/**
 * Split preview for Markdown tabs (T19).
 *
 * The buffer lives in CodeMirror; this pane re-renders from `getDocText` with a
 * 120 ms debounce. A short document keeps its scroll position in sync with the
 * editor. A longer one renders only a window around the reading position.
 */
export default function MarkdownPreview({
  tabId,
  name,
  baseDir,
  onExport,
  sourceOn = false,
  onToggleSource,
  syncScroll = true,
}: Props) {
  const resolvedTheme = useResolvedTheme();
  const { t } = useI18n();
  const headingsRef = useRef<OutlineItem[]>([]);
  const sourceRef = useRef<string | null>(null);
  const anchorRef = useRef(0);
  const pendingLine = useRef<number | null>(null);
  const adjusting = useRef(false);
  const renderAt = useCallback(
    (anchor: number): RenderedPreview => {
      const text = getDocText(tabId) ?? "";
      if (text !== sourceRef.current) {
        sourceRef.current = text;
        headingsRef.current = extractHeadings(text);
      }
      const slice =
        text.length <= FULL_PREVIEW_CHARS
          ? wholeDocument(text)
          : previewSlice(text, anchor, WINDOW_CHARS);
      return {
        html: renderMarkdown(slice.text, {
          sourceLines: true,
          lineOffset: slice.startLine,
          ...(baseDir ? { baseDir } : {}),
        }),
        headings: headingsRef.current,
        slice,
      };
    },
    [tabId, baseDir]
  );
  const [rendered, setRendered] = useState<RenderedPreview>(() => ({
    html: "",
    headings: [],
    slice: wholeDocument(""),
  }));
  const [outlineOpen, setOutlineOpen] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const syncing = useRef<"editor" | "preview" | null>(null);
  const { html, headings, slice } = rendered;

  const placeWindow = useCallback(
    (line: number) => {
      const next = Math.max(0, line);
      anchorRef.current = next;
      pendingLine.current = next;
      setRendered(renderAt(next));
    },
    [renderAt]
  );

  // Re-render after edits, debounced so typing does not reparse on each keystroke.
  // A long document only re-renders the window around the reading position.
  useEffect(() => {
    let debounce: number | undefined;
    const render = () => setRendered(renderAt(anchorRef.current));

    // The initial state runs during render, before the editor registers its view,
    // so pull the real buffer once after mount (deferred to satisfy the effect rule).
    const initial = window.setTimeout(render, 0);
    const schedule = () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(render, 120);
    };
    const unsubscribe = subscribeDocChanges(tabId, schedule);

    return () => {
      window.clearTimeout(initial);
      window.clearTimeout(debounce);
      unsubscribe();
    };
  }, [tabId, resolvedTheme, renderAt]);

  // After the window shifts, keep the line the reader was on in view.
  useLayoutEffect(() => {
    const line = pendingLine.current;
    const scroller = scrollerRef.current;
    if (line == null || !scroller) return;
    pendingLine.current = null;
    const body = scroller.querySelector(".markdown-preview__body");
    const target = body ? elementForLine(body, line) : null;
    adjusting.current = true;
    if (target) {
      const offset =
        target.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      scroller.scrollTop = Math.max(0, offset - 8);
    } else {
      scroller.scrollTop = 0;
    }
    const frame = window.requestAnimationFrame(() => {
      adjusting.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [html]);

  // A selection in the preview becomes the editor selection, so Ctrl+K, the
  // floating AI action and the AI panel work the same with the source hidden.
  useEffect(() => {
    const onSelectionChange = () => {
      const selection = document.getSelection();
      const body = scrollerRef.current?.querySelector(".markdown-preview__body");
      if (!selection || selection.rangeCount === 0 || !body) return;
      const range = selection.getRangeAt(0);
      if (!body.contains(range.commonAncestorContainer)) return;
      if (range.collapsed) {
        markTarget(null);
        const head = getEditorView(tabId)?.state.selection.main.head;
        if (head !== undefined) selectSourceRange(tabId, head, head);
        return;
      }
      const mapped = sourceRangeForPreviewSelection(body, range, getDocText(tabId) ?? "");
      if (!mapped) return;
      selectSourceRange(tabId, mapped.from, mapped.to);
      markTarget(range.cloneRange());
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      markTarget(null);
    };
  }, [tabId]);

  // A re-render replaces the nodes the highlight pointed at.
  useEffect(() => () => markTarget(null), [html]);

  // Relative images cannot be loaded by the webview directly; read them through
  // Rust and inline them as data URIs after each render (T19 image paste).
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;
    let cancelled = false;
    for (const image of root.querySelectorAll<HTMLImageElement>("img[data-local-path]")) {
      const localPath = image.getAttribute("data-local-path");
      if (!localPath || image.dataset.assetSrc === "1") continue;
      image.dataset.assetSrc = "1";
      void loadImageDataUrl(localPath).then((uri) => {
        if (!cancelled && uri && image.isConnected) image.src = uri;
      });
    }
    return () => {
      cancelled = true;
    };
  }, [html, resolvedTheme]);

  // Upgrade escaped code blocks to Shiki-highlighted ones (lazy load, once).
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;
    let cancelled = false;

    for (const block of Array.from(root.querySelectorAll<HTMLElement>("pre.md-code"))) {
      const code = block.querySelector("code");
      const language = /language-([\w-]+)/.exec(code?.className ?? "")?.[1];
      const source = code?.textContent ?? "";
      if (!language || language.toLowerCase() === "mermaid" || !source.trim()) continue;

      void highlightCode(source, language, resolvedTheme).then((highlighted) => {
        if (cancelled || !highlighted || !block.isConnected) return;
        block.outerHTML = highlighted;
      });
    }

    return () => {
      cancelled = true;
    };
  }, [html, resolvedTheme]);

  // KaTeX and Mermaid load on demand. A failed formula or diagram stays as text.
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    const mathNodes = Array.from(root.querySelectorAll<HTMLElement>(".math-inline, .math-block"));
    const mermaidNodes = Array.from(
      root.querySelectorAll<HTMLElement>("pre.md-code code.language-mermaid")
    );
    if (mathNodes.length === 0 && mermaidNodes.length === 0) return;

    void (async () => {
      for (const node of mathNodes) {
        if (cancelled) return;
        const display =
          node.classList.contains("math-block") || node.classList.contains("math-display");
        const rendered = await renderKatexHtml(node.textContent ?? "", display);
        if (cancelled || !node.isConnected) return;
        if (rendered) node.innerHTML = rendered;
      }
      for (const code of mermaidNodes) {
        if (cancelled) return;
        const pre = code.closest("pre");
        if (!pre?.isConnected) continue;
        const svg = await renderMermaidSvg(code.textContent ?? "", resolvedTheme);
        if (cancelled || !pre.isConnected) return;
        if (!svg) continue;
        const diagram = document.createElement("div");
        diagram.className = "mermaid-diagram";
        diagram.innerHTML = svg;
        pre.replaceWith(diagram);
        cleanups.push(
          enhanceMermaidDiagram(diagram, {
            viewport: t("preview.diagram.viewport"),
            zoomOut: t("preview.diagram.zoomOut"),
            zoomIn: t("preview.diagram.zoomIn"),
            zoomReset: t("preview.diagram.zoomReset"),
            zoomLevel: (percent) => t("preview.diagram.zoomLevel", { percent }),
            zoomHint: t("preview.diagram.zoomHint"),
          })
        );
      }
    })();

    return () => {
      cancelled = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [html, resolvedTheme, t]);

  // Bidirectional, fraction-based scroll sync for a fully rendered document.
  // A windowed document follows the editor's top line instead of a fraction of
  // a DOM that no longer matches the file.
  useEffect(() => {
    if (!syncScroll || !slice.full) return;
    const editor = getScrollElement(tabId);
    const preview = scrollerRef.current;
    if (!editor || !preview) return;

    const onEditorScroll = () => {
      if (syncing.current === "preview") return;
      syncing.current = "editor";
      preview.scrollTop = topForFraction(
        scrollFraction({
          top: editor.scrollTop,
          height: editor.scrollHeight,
          client: editor.clientHeight,
        }),
        preview.scrollHeight,
        preview.clientHeight
      );
      requestAnimationFrame(() => {
        syncing.current = null;
      });
    };

    const onPreviewScroll = () => {
      if (syncing.current === "editor") return;
      syncing.current = "preview";
      editor.scrollTop = topForFraction(
        scrollFraction({
          top: preview.scrollTop,
          height: preview.scrollHeight,
          client: preview.clientHeight,
        }),
        editor.scrollHeight,
        editor.clientHeight
      );
      requestAnimationFrame(() => {
        syncing.current = null;
      });
    };

    editor.addEventListener("scroll", onEditorScroll, { passive: true });
    preview.addEventListener("scroll", onPreviewScroll, { passive: true });
    return () => {
      editor.removeEventListener("scroll", onEditorScroll);
      preview.removeEventListener("scroll", onPreviewScroll);
    };
  }, [tabId, syncScroll, slice.full]);

  // Move the window when the editor scrolls outside it, or the preview hits an edge.
  useEffect(() => {
    if (slice.full) return;
    const preview = scrollerRef.current;
    const editor = syncScroll ? getScrollElement(tabId) : null;
    let timer = 0;
    let lastPreviewTop = preview?.scrollTop ?? 0;

    const setWindow = (line: number) => {
      const next = Math.max(0, Math.min(line, Math.max(0, slice.totalLines - 1)));
      if (next === slice.startLine) return;
      placeWindow(next);
    };

    const onEditorScroll = () => {
      if (!editor) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const view = getEditorView(tabId);
        if (!view) return;
        const line =
          view.state.doc.lineAt(view.lineBlockAtHeight(editor.scrollTop).from).number - 1;
        const margin = Math.max(2, Math.floor((slice.endLine - slice.startLine) * 0.15));
        if (line >= slice.startLine + margin && line < slice.endLine - margin) return;
        setWindow(line);
      }, 80);
    };

    const onPreviewScroll = () => {
      if (!preview) return;
      const top = preview.scrollTop;
      const movedDown = top > lastPreviewTop;
      const movedUp = top < lastPreviewTop;
      lastPreviewTop = top;
      if (adjusting.current) return;
      if (preview.scrollHeight <= preview.clientHeight + 80) return;
      const nearEnd = top + preview.clientHeight >= preview.scrollHeight - 48;
      const nearStart = top < 24;
      if (movedDown && nearEnd && slice.endLine < slice.totalLines) {
        setWindow(slice.startLine + Math.floor((slice.endLine - slice.startLine) * 0.45));
      } else if (movedUp && nearStart && slice.startLine > 0) {
        const span = slice.endLine - slice.startLine;
        setWindow(Math.max(0, slice.startLine - Math.floor(span * 0.45)));
      }
    };

    editor?.addEventListener("scroll", onEditorScroll, { passive: true });
    preview?.addEventListener("scroll", onPreviewScroll, { passive: true });
    return () => {
      window.clearTimeout(timer);
      editor?.removeEventListener("scroll", onEditorScroll);
      preview?.removeEventListener("scroll", onPreviewScroll);
    };
  }, [tabId, syncScroll, slice, placeWindow]);

  const onPreviewClick = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      event.preventDefault();
      const slug = decodeURIComponent(href.slice(1));
      const heading = headings.find((item) => item.slug === slug);
      if (heading) jumpTo(slug, heading.line);
      else scrollerRef.current?.querySelector(href)?.scrollIntoView({ block: "start" });
      return;
    }
    event.preventDefault();
    if (isSafeHttpUrl(href)) {
      void openExternal(href).catch((error) =>
        useWorkspace.getState().setError(localizeError(error))
      );
      return;
    }
    useWorkspace.getState().setError(t("preview.externalLink"));
  };

  const jumpTo = (slug: string, line: number) => {
    if (!slice.full) {
      const anchor = Math.max(0, line - 1);
      placeWindow(anchor);
      setOutlineOpen(false);
      return;
    }
    const scroller = scrollerRef.current;
    const target = scroller?.querySelector<HTMLElement>(`[id="${slug}"]`);
    if (scroller && target) {
      // Compute the offset explicitly: `scrollIntoView` may scroll ancestor
      // containers (or the window) instead of the preview scroller.
      const offset =
        target.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      scroller.scrollTop = Math.max(0, offset - 8);
    }
    setOutlineOpen(false);
  };

  return (
    <div className="markdown-preview">
      <div className="markdown-preview__bar">
        <span className="markdown-preview__name" title={name}>
          {name}
        </span>
        {onToggleSource && (
          <button
            type="button"
            className={`markdown-preview__source${sourceOn ? " is-on" : ""}`}
            aria-pressed={sourceOn}
            title={t(sourceOn ? "preview.source.titleOn" : "preview.source.title")}
            onClick={onToggleSource}
          >
            {"</>"}
          </button>
        )}
        <button
          type="button"
          className={`markdown-preview__outline-toggle ${outlineOpen ? "is-on" : ""}`}
          disabled={headings.length === 0}
          title={t("preview.outlineToggle")}
          onClick={() => setOutlineOpen((open) => !open)}
        >
          {headings.length > 0
            ? t("preview.outlineCount", { count: headings.length })
            : t("preview.outline")}
        </button>
        <button type="button" className="markdown-preview__export" onClick={onExport}>
          {t("preview.export")}
        </button>
      </div>
      {!slice.full && (
        <p className="markdown-preview__window">
          {t("preview.window", {
            from: slice.startLine + 1,
            to: slice.endLine,
            total: slice.totalLines,
          })}
        </p>
      )}
      <div className="markdown-preview__scroll" ref={scrollerRef} onClick={onPreviewClick}>
        {html ? (
          <div
            key={resolvedTheme}
            className="markdown-preview__body"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <p className="markdown-preview__empty">{t("preview.empty")}</p>
        )}
      </div>
      {outlineOpen && headings.length > 0 && (
        <div
          className="markdown-preview__outline"
          role="navigation"
          aria-label={t("preview.outlineLabel")}
        >
          {headings.map((heading: OutlineItem) => (
            <button
              key={`${heading.slug}:${heading.line}`}
              type="button"
              className="markdown-preview__outline-item"
              style={{ paddingLeft: `${10 + (heading.level - 1) * 12}px` }}
              title={t("preview.line", { line: heading.line })}
              onClick={() => jumpTo(heading.slug, heading.line)}
            >
              {heading.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
