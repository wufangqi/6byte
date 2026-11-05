import type { DocEdit } from "../editor/docEdits";

/**
 * Map a candidate range through edits the person made after the agent read the document.
 * Edits strictly outside the range shift it. An edit that touches the range drops it.
 */
export function mapSpan(
  batches: readonly (readonly DocEdit[])[],
  from: number,
  to: number
): { from: number; to: number } | null {
  let span = { from, to };
  for (const batch of batches) {
    const next = mapBatch(batch, span.from, span.to);
    if (!next) return null;
    span = next;
  }
  return span;
}

function mapBatch(
  edits: readonly DocEdit[],
  from: number,
  to: number
): { from: number; to: number } | null {
  if (from < 0 || from > to) return null;
  let delta = 0;
  if (from === to) {
    // Insertion point: any edit that covers it makes the position ambiguous.
    for (const edit of edits) {
      if (edit.from <= from && edit.to > from) return null;
      if (edit.from === from && edit.to === from) return null;
      if (edit.to <= from) delta += edit.insert - (edit.to - edit.from);
    }
    return { from: from + delta, to: from + delta };
  }
  for (const edit of edits) {
    if (edit.from < to && edit.to > from) return null;
    if (edit.to <= from) delta += edit.insert - (edit.to - edit.from);
  }
  return { from: from + delta, to: to + delta };
}

/** Edits observed since the agent was allowed to read this document. */
export class RevisionLog {
  revision = 0;
  private base = 0;
  private batches: DocEdit[][] = [];

  constructor(private readonly cap = 4096) {}

  note(edits: readonly DocEdit[]): number {
    this.batches.push(edits.map((edit) => ({ ...edit })));
    this.revision += 1;
    while (this.batches.length > this.cap) {
      this.batches.shift();
      this.base += 1;
    }
    return this.revision;
  }

  /** Forget the mapping. Older revisions can no longer be placed. */
  invalidate(): number {
    this.batches = [];
    this.revision += 1;
    this.base = this.revision;
    return this.revision;
  }

  rebase(seen: number, from: number, to: number): { from: number; to: number } | null {
    if (seen > this.revision || seen < this.base) return null;
    return mapSpan(this.batches.slice(seen - this.base), from, to);
  }
}

export function placeCandidate(
  log: RevisionLog,
  seen: number,
  from: number,
  to: number,
  docLength: number
):
  | { status: "offered"; from: number; to: number; revision: number }
  | { status: "stale"; revision: number } {
  const mapped = log.rebase(seen, from, to);
  if (!mapped || mapped.from < 0 || mapped.to > docLength || mapped.from > mapped.to) {
    return { status: "stale", revision: log.revision };
  }
  return { status: "offered", from: mapped.from, to: mapped.to, revision: log.revision };
}
