import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  getEditorView,
  getSelectionSpan,
  subscribeDocChanges,
  subscribeSourceSelection,
} from "../editor/registry";
import { useI18n } from "../i18n";

interface Props {
  tabId: string;
  visible: boolean;
  onRewrite(): void;
}

interface Position {
  left: number;
  top: number;
}

/** End of a selection made in the Markdown preview, which mirrors into the editor. */
function previewSelectionEnd(): { left: number; bottom: number } | null {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const element = container instanceof Element ? container : container.parentElement;
  if (!element?.closest(".markdown-preview__body")) return null;
  const rects = range.getClientRects();
  const last = rects[rects.length - 1];
  return last ? { left: last.right, bottom: last.bottom } : null;
}

function nextPosition(tabId: string): Position | null {
  const view = getEditorView(tabId);
  const selection = getSelectionSpan(tabId);
  if (!view || !selection) return null;
  const editorShown = view.dom.getClientRects().length > 0;
  const coords = previewSelectionEnd() ?? (editorShown ? view.coordsAtPos(selection.to) : null);
  if (!coords) return null;
  // The action is centered under the selection endpoint and held inside the viewport.
  return {
    left: Math.max(72, Math.min(window.innerWidth - 72, coords.left)),
    top: Math.max(8, Math.min(window.innerHeight - 42, coords.bottom + 7)),
  };
}

/**
 * A lightweight default-path entry: it only appears after text is selected,
 * keeps the editor selection intact, and opens the existing trusted rewrite
 * panel. No document text is sent until the user writes an instruction and
 * presses Send there.
 */
export default function AiSelectionAction({ tabId, visible, onRewrite }: Props) {
  const { t } = useI18n();
  const [position, setPosition] = useState<Position | null>(null);

  useEffect(() => {
    if (!visible) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setPosition(nextPosition(tabId)));
    };
    update();
    window.addEventListener("keyup", update);
    window.addEventListener("mouseup", update);
    window.addEventListener("resize", update);
    document.addEventListener("selectionchange", update);
    // Capture catches the preview scroller as well as the editor.
    document.addEventListener("scroll", update, { capture: true, passive: true });
    const stop = subscribeDocChanges(tabId, update);
    const stopSource = subscribeSourceSelection(tabId, update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keyup", update);
      window.removeEventListener("mouseup", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("scroll", update, { capture: true });
      stop();
      stopSource();
    };
  }, [tabId, visible]);

  if (!visible || !position) return null;
  return createPortal(
    <button
      type="button"
      className="ai-selection-action"
      style={{ left: position.left, top: position.top }}
      title={t("ai.entry.rewriteTitle")}
      aria-label={t("ai.entry.rewriteTitle")}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onRewrite}
    >
      <span aria-hidden="true">✦</span>
      {t("ai.entry.rewrite")}
      <kbd>Ctrl+K</kbd>
    </button>,
    document.body
  );
}
