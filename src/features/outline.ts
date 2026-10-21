import { createSlugTracker, plainHeadingText, slugFor } from "./markdown";

export interface OutlineItem {
  level: number;
  text: string;
  slug: string;
  /** 1-based source line. */
  line: number;
}

/**
 * Extract ATX headings (`# Title`) from Markdown source.
 *
 * Fenced code blocks are skipped so `# comments` inside code do not show up.
 * Slugs use the same dedupe logic as the renderer, so the outline can jump to
 * the rendered heading ids.
 */
export function extractHeadings(source: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const tracker = createSlugTracker();
  let fence: string | null = null;

  source.split(/\r?\n/).forEach((line, index) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      return;
    }
    if (fence !== null) return;

    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!heading) return;

    const raw = heading[2].trim();
    items.push({
      level: heading[1].length,
      text: plainHeadingText(raw),
      slug: slugFor(raw, tracker),
      line: index + 1,
    });
  });

  return items;
}
