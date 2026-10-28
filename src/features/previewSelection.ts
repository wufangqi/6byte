/**
 * Map a selection in the rendered Markdown preview back to a source range.
 *
 * Block elements carry `data-src="start:end"` (see `renderMarkdown`). The
 * selection widens to the innermost blocks it touches; when the selected text
 * also appears verbatim exactly once in that source, the range narrows to it.
 * Formatting markup (`**`, links, list markers) usually prevents a verbatim
 * match, so a styled selection rewrites whole blocks.
 */

export interface SourceRange {
  from: number;
  to: number;
}

function lineRange(element: Element): [number, number] | null {
  const match = /^(\d+):(\d+)$/.exec(element.getAttribute("data-src") ?? "");
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return end > start ? [start, end] : null;
}

/** The part of `range` inside `element` has visible text. */
function touches(range: Range, element: Element): boolean {
  if (!range.intersectsNode(element)) return false;
  const inner = element.ownerDocument.createRange();
  inner.selectNodeContents(element);
  if (range.compareBoundaryPoints(Range.START_TO_START, inner) > 0) {
    inner.setStart(range.startContainer, range.startOffset);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, inner) < 0) {
    inner.setEnd(range.endContainer, range.endOffset);
  }
  return inner.toString().trim() !== "";
}

/** Character offset where 0-based `line` starts; `lines` past the end clamp to the length. */
function lineOffset(doc: string, line: number): number {
  let offset = 0;
  for (let index = 0; index < line; index += 1) {
    const next = doc.indexOf("\n", offset);
    if (next < 0) return doc.length;
    offset = next + 1;
  }
  return offset;
}

export function sourceRangeForPreviewSelection(
  root: Element,
  range: Range,
  doc: string
): SourceRange | null {
  if (range.collapsed) return null;
  const blocks = [...root.querySelectorAll("[data-src]")].filter((element) =>
    touches(range, element)
  );
  const innermost = blocks.filter(
    (element) => !blocks.some((other) => other !== element && element.contains(other))
  );
  let start = Infinity;
  let end = -Infinity;
  for (const element of innermost) {
    const lines = lineRange(element);
    if (!lines) continue;
    start = Math.min(start, lines[0]);
    end = Math.max(end, lines[1]);
  }
  if (!Number.isFinite(start)) return null;

  const from = lineOffset(doc, start);
  let to = lineOffset(doc, end);
  while (to > from && (doc[to - 1] === "\n" || doc[to - 1] === "\r")) to -= 1;
  if (to <= from) return null;

  const selected = range.toString().trim();
  const source = doc.slice(from, to);
  const at = selected ? source.indexOf(selected) : -1;
  if (at >= 0 && source.indexOf(selected, at + 1) < 0) {
    return { from: from + at, to: from + at + selected.length };
  }
  return { from, to };
}
