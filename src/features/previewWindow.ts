/**
 * Long Markdown is not rendered as one document.
 *
 * A full render of a few megabytes builds a DOM large enough to miss the
 * preview budget (see docs/perf.md). Documents above `FULL_PREVIEW_CHARS`
 * render a window of about `WINDOW_CHARS` around the reading position instead.
 * A fenced code block is never cut in half; a single block may exceed the window.
 */

/** At or below this, the preview renders the whole document and scroll-syncs. */
export const FULL_PREVIEW_CHARS = 80_000;

/** Source characters kept in the DOM for a longer document. */
export const WINDOW_CHARS = 24_000;

export interface PreviewSlice {
  text: string;
  /** 0-based, inclusive. */
  startLine: number;
  /** 0-based, exclusive. */
  endLine: number;
  totalLines: number;
  /** The slice covers the whole document. */
  full: boolean;
}

interface Line {
  start: number;
  end: number;
  text: string;
}

interface Block {
  startLine: number;
  endLine: number;
  start: number;
  end: number;
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^#{1,6}\s+\S/;

function indexLines(source: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code !== 10 && code !== 13) continue;
    const end = code === 13 && source.charCodeAt(index + 1) === 10 ? index + 2 : index + 1;
    lines.push({ start, end, text: source.slice(start, index) });
    index = end - 1;
    start = end;
  }
  if (start < source.length || lines.length === 0) {
    lines.push({ start, end: source.length, text: source.slice(start) });
  }
  return lines;
}

/** Top-level blocks. Fences stay intact; anything else is split once it passes `maxChars`. */
function blocksFrom(lines: Line[], maxChars: number): Block[] {
  const blocks: Block[] = [];
  let startLine = 0;
  let inFence = false;

  const emit = (endLine: number) => {
    if (endLine <= startLine) return;
    blocks.push({
      startLine,
      endLine,
      start: lines[startLine].start,
      end: lines[endLine - 1].end,
    });
    startLine = endLine;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index].text;
    if (FENCE.test(text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || index === startLine) continue;
    if (HEADING.test(text)) {
      emit(index);
      continue;
    }
    if (text.trim() === "") {
      emit(index + 1);
      continue;
    }
    if (lines[index].end - lines[startLine].start > maxChars) emit(index);
  }
  emit(lines.length);
  return blocks;
}

let cachedSource = "";
let cachedMax = -1;
let cachedLines: Line[] = [];
let cachedBlocks: Block[] = [];

function blocksFor(source: string, maxChars: number): { lines: Line[]; blocks: Block[] } {
  if (source === cachedSource && maxChars === cachedMax && cachedBlocks.length > 0) {
    return { lines: cachedLines, blocks: cachedBlocks };
  }
  const lines = indexLines(source);
  const blocks = blocksFrom(lines, maxChars);
  cachedSource = source;
  cachedMax = maxChars;
  cachedLines = lines;
  cachedBlocks = blocks;
  return { lines, blocks };
}

export function wholeDocument(source: string): PreviewSlice {
  if (source.length === 0) {
    return { text: "", startLine: 0, endLine: 0, totalLines: 0, full: true };
  }
  const totalLines = indexLines(source).length;
  return { text: source, startLine: 0, endLine: totalLines, totalLines, full: true };
}

/**
 * The blocks from `anchorLine` forward that fit in `maxChars`.
 * Always includes the block containing the anchor, even when that block is longer.
 */
export function previewSlice(source: string, anchorLine: number, maxChars: number): PreviewSlice {
  if (source.length === 0) return wholeDocument(source);
  const { lines, blocks } = blocksFor(source, maxChars);
  const totalLines = lines.length;
  const anchor = Math.max(0, Math.min(anchorLine, totalLines - 1));
  let index = blocks.findIndex((block) => anchor >= block.startLine && anchor < block.endLine);
  if (index < 0) index = blocks.length - 1;

  let last = index;
  let chars = blocks[last].end - blocks[last].start;
  while (last + 1 < blocks.length) {
    const next = blocks[last + 1].end - blocks[last + 1].start;
    if (chars + next > maxChars) break;
    last += 1;
    chars += next;
  }

  const first = blocks[index];
  const end = blocks[last];
  return {
    text: source.slice(first.start, end.end),
    startLine: first.startLine,
    endLine: end.endLine,
    totalLines,
    full: first.startLine === 0 && end.endLine === totalLines,
  };
}
