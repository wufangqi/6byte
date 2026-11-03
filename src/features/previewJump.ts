type PreviewJump = (line: number) => void;

let listener: PreviewJump | null = null;

/** Ask the open preview tab to scroll to a 1-based source line. */
export function requestPreviewJump(line: number): void {
  listener?.(line);
}

export function subscribePreviewJump(next: PreviewJump): () => void {
  listener = next;
  return () => {
    if (listener === next) listener = null;
  };
}
