/**
 * Scroll offset of a Markdown preview tab.
 *
 * The preview unmounts when another tab is selected. The offset is kept here
 * so coming back opens at the same place. A hidden scroller reports 0 and must
 * not overwrite a real offset.
 */
const tops = new Map<string, number>();

export function previewScrollTop(tabId: string): number {
  return tops.get(tabId) ?? 0;
}

export function notePreviewScroll(tabId: string, scroller: HTMLElement): void {
  if (!scroller.isConnected || scroller.clientHeight <= 0) return;
  tops.set(tabId, scroller.scrollTop);
}

export function dropPreviewScrollExcept(keep: ReadonlySet<string>): void {
  for (const tabId of [...tops.keys()]) {
    if (!keep.has(tabId)) tops.delete(tabId);
  }
}
