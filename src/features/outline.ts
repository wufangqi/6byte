import { parseDocument, type OutlineItem } from "./documentModel";

export type { OutlineItem };

/**
 * ATX headings from the shared document model.
 *
 * The command palette, `@` mentions and the read-only outline all use this
 * list, so a heading skipped in one place is skipped in the others.
 */
export function extractHeadings(source: string): OutlineItem[] {
  return parseDocument(source).headings;
}
