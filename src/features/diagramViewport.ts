/** Zoom limits for Mermaid diagrams in the Markdown preview. */
export const MIN_DIAGRAM_ZOOM = 25;
export const MAX_DIAGRAM_ZOOM = 300;
export const DIAGRAM_ZOOM_STEP = 25;

export interface DiagramViewportLabels {
  viewport: string;
  zoomOut: string;
  zoomIn: string;
  zoomReset: string;
  zoomLevel(percent: number): string;
  zoomHint: string;
}

export function clampDiagramZoom(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.min(MAX_DIAGRAM_ZOOM, Math.max(MIN_DIAGRAM_ZOOM, Math.round(value)));
}

function viewBoxWidth(svg: SVGSVGElement): number {
  const values = svg
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (values && values.length === 4 && Number.isFinite(values[2]) && values[2] > 0) {
    return values[2];
  }
  const width = Number.parseFloat(svg.getAttribute("width") ?? "");
  return Number.isFinite(width) && width > 0 ? width : 800;
}

function createButton(label: string, icon: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mermaid-diagram__control";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.textContent = icon;
  return button;
}

/**
 * Add accessible zoom, reset and drag-to-pan controls to an already-rendered
 * Mermaid SVG. The returned cleanup removes listeners when Markdown re-renders.
 */
export function enhanceMermaidDiagram(
  diagram: HTMLElement,
  labels: DiagramViewportLabels
): () => void {
  const svg = diagram.querySelector<SVGSVGElement>("svg");
  if (!svg) return () => {};

  const measuredWidth = svg.getBoundingClientRect().width;
  const baseWidth = measuredWidth > 0 ? measuredWidth : viewBoxWidth(svg);
  let zoom = 100;
  let drag: { pointerId: number; x: number; y: number; left: number; top: number } | undefined;

  const toolbar = document.createElement("div");
  toolbar.className = "mermaid-diagram__toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", labels.viewport);

  const zoomOut = createButton(labels.zoomOut, "−");
  const level = document.createElement("output");
  level.className = "mermaid-diagram__zoom-level";
  level.setAttribute("aria-live", "polite");
  level.title = labels.zoomHint;
  const zoomIn = createButton(labels.zoomIn, "+");
  const reset = createButton(labels.zoomReset, "↺");
  toolbar.append(zoomOut, level, zoomIn, reset);

  const viewport = document.createElement("div");
  viewport.className = "mermaid-diagram__viewport";
  viewport.tabIndex = 0;
  viewport.setAttribute("aria-label", labels.viewport);
  viewport.title = labels.zoomHint;
  viewport.append(svg);

  diagram.replaceChildren(toolbar, viewport);

  const update = () => {
    if (zoom === 100) {
      svg.style.removeProperty("width");
      svg.style.removeProperty("max-width");
    } else {
      svg.style.width = `${Math.round((baseWidth * zoom) / 100)}px`;
      svg.style.maxWidth = "none";
    }
    svg.style.height = "auto";
    level.value = String(zoom);
    level.textContent = labels.zoomLevel(zoom);
    zoomOut.disabled = zoom <= MIN_DIAGRAM_ZOOM;
    zoomIn.disabled = zoom >= MAX_DIAGRAM_ZOOM;
    reset.disabled = zoom === 100;
  };

  const setZoom = (next: number) => {
    zoom = clampDiagramZoom(next);
    update();
  };

  const onZoomOut = () => setZoom(zoom - DIAGRAM_ZOOM_STEP);
  const onZoomIn = () => setZoom(zoom + DIAGRAM_ZOOM_STEP);
  const onReset = () => setZoom(100);
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    if (event.deltaY !== 0)
      setZoom(zoom + (event.deltaY < 0 ? DIAGRAM_ZOOM_STEP : -DIAGRAM_ZOOM_STEP));
  };
  const finishDrag = (event?: PointerEvent) => {
    if (!drag) return;
    if (event && event.pointerId !== drag.pointerId) return;
    if (viewport.hasPointerCapture(drag.pointerId)) viewport.releasePointerCapture(drag.pointerId);
    drag = undefined;
    viewport.classList.remove("is-panning");
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    if (
      viewport.scrollWidth <= viewport.clientWidth &&
      viewport.scrollHeight <= viewport.clientHeight
    ) {
      return;
    }
    drag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
    };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add("is-panning");
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    viewport.scrollLeft = drag.left - (event.clientX - drag.x);
    viewport.scrollTop = drag.top - (event.clientY - drag.y);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      onZoomIn();
    } else if (event.key === "-") {
      event.preventDefault();
      onZoomOut();
    } else if (event.key === "0") {
      event.preventDefault();
      onReset();
    }
  };

  zoomOut.addEventListener("click", onZoomOut);
  zoomIn.addEventListener("click", onZoomIn);
  reset.addEventListener("click", onReset);
  viewport.addEventListener("wheel", onWheel, { passive: false });
  viewport.addEventListener("pointerdown", onPointerDown);
  viewport.addEventListener("pointermove", onPointerMove);
  viewport.addEventListener("pointerup", finishDrag);
  viewport.addEventListener("pointercancel", finishDrag);
  viewport.addEventListener("keydown", onKeyDown);
  update();

  return () => {
    finishDrag();
    zoomOut.removeEventListener("click", onZoomOut);
    zoomIn.removeEventListener("click", onZoomIn);
    reset.removeEventListener("click", onReset);
    viewport.removeEventListener("wheel", onWheel);
    viewport.removeEventListener("pointerdown", onPointerDown);
    viewport.removeEventListener("pointermove", onPointerMove);
    viewport.removeEventListener("pointerup", finishDrag);
    viewport.removeEventListener("pointercancel", finishDrag);
    viewport.removeEventListener("keydown", onKeyDown);
  };
}
