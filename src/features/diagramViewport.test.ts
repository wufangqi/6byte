// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  DIAGRAM_ZOOM_STEP,
  MAX_DIAGRAM_ZOOM,
  MIN_DIAGRAM_ZOOM,
  clampDiagramZoom,
  enhanceMermaidDiagram,
  type DiagramViewportLabels,
} from "./diagramViewport";

const labels: DiagramViewportLabels = {
  viewport: "Diagram viewer",
  zoomOut: "Zoom out",
  zoomIn: "Zoom in",
  zoomReset: "Reset zoom",
  zoomLevel: (percent) => `Zoom ${percent}%`,
  zoomHint: "Use controls to zoom",
};

describe("clampDiagramZoom", () => {
  it("keeps zoom within the supported range", () => {
    expect(clampDiagramZoom(Number.NaN)).toBe(100);
    expect(clampDiagramZoom(MIN_DIAGRAM_ZOOM - 1)).toBe(MIN_DIAGRAM_ZOOM);
    expect(clampDiagramZoom(MAX_DIAGRAM_ZOOM + 1)).toBe(MAX_DIAGRAM_ZOOM);
  });
});

describe("enhanceMermaidDiagram", () => {
  it("adds accessible controls and scales the rendered svg", () => {
    const diagram = document.createElement("div");
    diagram.innerHTML = '<svg viewBox="0 0 160 80"></svg>';
    document.body.append(diagram);

    const cleanup = enhanceMermaidDiagram(diagram, labels);
    const svg = diagram.querySelector("svg") as SVGSVGElement;
    const zoomIn = diagram.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]');
    const zoomOut = diagram.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]');
    const reset = diagram.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]');

    expect(diagram.querySelector('[role="toolbar"]')).not.toBeNull();
    expect(diagram.querySelector<HTMLElement>(".mermaid-diagram__viewport")?.tabIndex).toBe(0);
    expect(zoomIn).not.toBeNull();
    expect(zoomOut).not.toBeNull();
    expect(reset).not.toBeNull();
    expect(reset?.disabled).toBe(true);

    zoomIn?.click();
    expect(svg.style.width).toBe(`${160 + (160 * DIAGRAM_ZOOM_STEP) / 100}px`);
    expect(diagram.textContent).toContain("Zoom 125%");
    expect(reset?.disabled).toBe(false);

    reset?.click();
    expect(svg.style.width).toBe("");
    expect(diagram.textContent).toContain("Zoom 100%");

    cleanup();
    diagram.remove();
  });
});
