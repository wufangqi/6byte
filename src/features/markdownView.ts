/** Whether a newly opened Markdown file shows the source beside the preview. */
export const MARKDOWN_SOURCE_KEY = "ainative.markdownSource";

/** The last `</>` choice. Missing or unreadable storage means preview only. */
export function markdownSourcePreferred(): boolean {
  try {
    return localStorage.getItem(MARKDOWN_SOURCE_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberMarkdownSource(shown: boolean): void {
  try {
    localStorage.setItem(MARKDOWN_SOURCE_KEY, shown ? "1" : "0");
  } catch {
    // The next file still opens; the preference is only a convenience.
  }
}
