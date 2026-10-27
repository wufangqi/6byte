/**
 * A small, bounded line diff for reviewing an AI rewrite before it reaches the
 * document. Unreviewed and explicitly discarded changes always resolve to the
 * original text, so applying selected hunks cannot accidentally include a
 * neighbouring model change.
 */

export type RewriteHunkState = "pending" | "accepted" | "discarded";

export interface RewriteHunk {
  id: string;
  original: string;
  replacement: string;
  state: RewriteHunkState;
}

export type RewriteReviewPart =
  { kind: "same"; text: string } | { kind: "change"; hunk: RewriteHunk };

export interface RewriteReview {
  parts: RewriteReviewPart[];
}

const MAX_DIFF_LINES = 240;

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
}

function singleHunk(original: string, replacement: string): RewriteReview {
  return {
    parts: [
      {
        kind: "change",
        hunk: { id: "hunk-1", original, replacement, state: "pending" },
      },
    ],
  };
}

interface DiffPart {
  kind: "same" | "removed" | "added";
  text: string;
}

function lineDiff(original: string[], replacement: string[]): DiffPart[] {
  const rows = original.length;
  const columns = replacement.length;
  const table = Array.from({ length: rows + 1 }, () => new Uint16Array(columns + 1));

  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[row][column] =
        original[row] === replacement[column]
          ? table[row + 1][column + 1] + 1
          : Math.max(table[row + 1][column], table[row][column + 1]);
    }
  }

  const parts: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    const previous = parts.at(-1);
    if (previous?.kind === kind) previous.text += text;
    else parts.push({ kind, text });
  };
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (original[row] === replacement[column]) {
      push("same", original[row]);
      row += 1;
      column += 1;
    } else if (table[row + 1][column] >= table[row][column + 1]) {
      push("removed", original[row]);
      row += 1;
    } else {
      push("added", replacement[column]);
      column += 1;
    }
  }
  while (row < rows) {
    push("removed", original[row]);
    row += 1;
  }
  while (column < columns) {
    push("added", replacement[column]);
    column += 1;
  }
  return parts;
}

/** Build independently reviewable changed blocks. Very large line sets use one safe block. */
export function createRewriteReview(original: string, replacement: string): RewriteReview {
  if (original === replacement) return { parts: [{ kind: "same", text: original }] };
  const originalLines = splitLines(original);
  const replacementLines = splitLines(replacement);
  if (originalLines.length > MAX_DIFF_LINES || replacementLines.length > MAX_DIFF_LINES) {
    return singleHunk(original, replacement);
  }

  const parts: RewriteReviewPart[] = [];
  let changedOriginal = "";
  let changedReplacement = "";
  let count = 0;
  const flushChange = () => {
    if (!changedOriginal && !changedReplacement) return;
    count += 1;
    parts.push({
      kind: "change",
      hunk: {
        id: `hunk-${count}`,
        original: changedOriginal,
        replacement: changedReplacement,
        state: "pending",
      },
    });
    changedOriginal = "";
    changedReplacement = "";
  };

  for (const part of lineDiff(originalLines, replacementLines)) {
    if (part.kind === "same") {
      flushChange();
      const previous = parts.at(-1);
      if (previous?.kind === "same") previous.text += part.text;
      else parts.push({ kind: "same", text: part.text });
    } else if (part.kind === "removed") {
      changedOriginal += part.text;
    } else {
      changedReplacement += part.text;
    }
  }
  flushChange();
  return { parts };
}

export function rewriteHunks(review: RewriteReview | null): RewriteHunk[] {
  if (!review) return [];
  return review.parts.flatMap((part) => (part.kind === "change" ? [part.hunk] : []));
}

export function updateRewriteHunk(
  review: RewriteReview,
  id: string,
  state: RewriteHunkState
): RewriteReview {
  return {
    parts: review.parts.map((part) =>
      part.kind !== "change" || part.hunk.id !== id
        ? part
        : { ...part, hunk: { ...part.hunk, state } }
    ),
  };
}

/** Replacement text that applies only explicitly accepted change blocks. */
export function acceptedRewriteText(review: RewriteReview): string {
  return review.parts
    .map((part) => {
      if (part.kind === "same") return part.text;
      return part.hunk.state === "accepted" ? part.hunk.replacement : part.hunk.original;
    })
    .join("");
}

export function acceptedRewriteCount(review: RewriteReview | null): number {
  return rewriteHunks(review).filter((hunk) => hunk.state === "accepted").length;
}
