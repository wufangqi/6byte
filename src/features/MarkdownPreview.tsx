import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { getDocText, getScrollElement, subscribeDocChanges } from "../editor/registry";
import { loadImageDataUrl } from "./images";
import { useWorkspace } from "../stores/workspace";
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
export default function MarkdownPreview({ tabId, name, baseDir, onExport }: Props) {
  const [rendered, setRendered] = useState(() => renderAll(tabId, baseDir));
  const [outlineOpen, setOutlineOpen] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const syncing = useRef<"editor" | "preview" | null>(null);
  const { html, headings } = rendered;

  // Re-render after edits, debounced so typing does not reparse on each keystroke.
  useEffect(() => {
    let debounce: number | undefined;
    const render = () => setRendered(renderAll(tabId, baseDir));

    // The initial state runs during render, before CodeEditor registers its view,
    // so pull the real buffer once after mount (deferred to satisfy the effect rule).
    const initial = window.setTimeout(render, 0);
    const unsubscribe = subscribeDocChanges(tabId, () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(render, 120);
    });

    return () => {
      window.clearTimeout(initial);
      window.clearTimeout(debounce);
      unsubscribe();
    };
  }, [tabId, baseDir]);

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
  }, [html]);

  // Upgrade escaped code blocks to Shiki-highlighted ones (lazy load, once).
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;
    let cancelled = false;

    for (const block of Array.from(root.querySelectorAll<HTMLElement>("pre.md-code"))) {
      const code = block.querySelector("code");
      const language = /language-([\w-]+)/.exec(code?.className ?? "")?.[1];
      const source = code?.textContent ?? "";
      if (!language || !source.trim()) continue;

      void highlightCode(source, language).then((highlighted) => {
        if (cancelled || !highlighted || !block.isConnected) return;
        block.outerHTML = highlighted;
      });
    }

    return () => {
      cancelled = true;
    };
  }, [html]);

  // Bidirectional, fraction-based scroll sync; the editor remains the source of truth.
  useEffect(() => {
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
  }, [tabId]);

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
    useWorkspace.getState().setError("预览暂不支持在应用内打开外部链接（M2 后续接入系统浏览器）。");
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
        <button
          type="button"
          className={`markdown-preview__outline-toggle ${outlineOpen ? "is-on" : ""}`}
          disabled={headings.length === 0}
          title="显示 / 隐藏大纲"
          onClick={() => setOutlineOpen((open) => !open)}
        >
          大纲{headings.length > 0 ? `（${headings.length}）` : ""}
        </button>
        <button type="button" className="markdown-preview__export" onClick={onExport}>
          导出 HTML
        </button>
      </div>
      <div className="markdown-preview__scroll" ref={scrollerRef} onClick={onPreviewClick}>
        {html ? (
          <div className="markdown-preview__body" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <p className="markdown-preview__empty">没有可预览的内容。</p>
        )}
      </div>
      {outlineOpen && headings.length > 0 && (
        <div className="markdown-preview__outline" role="navigation" aria-label="大纲">
          {headings.map((heading: OutlineItem) => (
            <button
              key={`${heading.slug}:${heading.line}`}
              type="button"
              className="markdown-preview__outline-item"
              style={{ paddingLeft: `${10 + (heading.level - 1) * 12}px` }}
              title={`第 ${heading.line} 行`}
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
