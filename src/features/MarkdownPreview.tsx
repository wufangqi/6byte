import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { getDocText, getScrollElement, subscribeDocChanges } from "../editor/registry";
import { loadImageDataUrl } from "./images";
import { useWorkspace } from "../stores/workspace";
import { renderKatexHtml, renderMermaidSvg } from "./diagrams";
import { useI18n } from "../i18n";
import { useResolvedTheme } from "./theme";
import { renderMarkdown } from "./markdown";
import { highlightCode } from "./highlight";
import { extractHeadings, type OutlineItem } from "./outline";
import { scrollFraction, topForFraction } from "./scrollSync";

interface Props {
  tabId: string;
  name: string;
  /** Directory of the document; resolves `assets/…` image paths. */
  baseDir: string | null;
  onExport(): void;
  /** Markdown opens in preview. `<>` reveals the source beside it. */
  sourceOn?: boolean;
  onToggleSource?: () => void;
  /** Skip editor scroll sync while the source pane is hidden. */
  syncScroll?: boolean;
}

const renderAll = (tabId: string, baseDir: string | null) => {
  const text = getDocText(tabId) ?? "";
  return {
    html: renderMarkdown(text, baseDir ? { baseDir } : {}),
    headings: extractHeadings(text),
  };
};

/**
 * Split preview for Markdown tabs (T19).
 *
 * The buffer lives in CodeMirror; this pane re-renders from `getDocText` with a
 * 120 ms debounce and keeps its scroll position in sync with the editor.
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
  const [rendered, setRendered] = useState(() => renderAll(tabId, baseDir));
  const [outlineOpen, setOutlineOpen] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const syncing = useRef<"editor" | "preview" | null>(null);
  const { html, headings } = rendered;

  // Re-render after edits, debounced so typing does not reparse on each keystroke.
  useEffect(() => {
    let debounce: number | undefined;
    const render = () => {
      setRendered(renderAll(tabId, baseDir));
    };

    // The initial state runs during render, before CodeEditor registers its view,
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
    // The resolved theme is a dependency so switching themes re-renders the
    // markdown and lets the Shiki/Mermaid effects repaint with the new palette.
  }, [tabId, baseDir, resolvedTheme]);

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
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [html, resolvedTheme]);

  // Bidirectional, fraction-based scroll sync; the editor remains the source of truth.
  useEffect(() => {
    if (!syncScroll) return;
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
  }, [tabId, syncScroll]);

  const onPreviewClick = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      event.preventDefault();
      scrollerRef.current?.querySelector(href)?.scrollIntoView({ block: "start" });
      return;
    }
    event.preventDefault();
    useWorkspace.getState().setError(t("preview.externalLink"));
  };

  const jumpTo = (slug: string) => {
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
            {"<>"}
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
              onClick={() => jumpTo(heading.slug)}
            >
              {heading.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
