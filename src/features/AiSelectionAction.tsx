import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getEditorView, getSelectionSpan, subscribeDocChanges } from "../editor/registry";
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

function nextPosition(tabId: string): Position | null {
  const view = getEditorView(tabId);
  const selection = getSelectionSpan(tabId);
  if (!view || !selection) return null;
  const coords = view.coordsAtPos(selection.to);
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
    const view = getEditorView(tabId);
    update();
    window.addEventListener("keyup", update);
    window.addEventListener("mouseup", update);
    window.addEventListener("resize", update);
    document.addEventListener("selectionchange", update);
    view?.scrollDOM.addEventListener("scroll", update, { passive: true });
    const stop = subscribeDocChanges(tabId, update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keyup", update);
      window.removeEventListener("mouseup", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("selectionchange", update);
      view?.scrollDOM.removeEventListener("scroll", update);
      stop();
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
