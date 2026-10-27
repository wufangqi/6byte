import { resolveWorkspacePath } from "./readAgent";

export interface AnswerReference {
  /** Character offsets in the answer, excluding surrounding Markdown punctuation. */
  start: number;
  end: number;
  /** Absolute, workspace-confined path suitable for opening. */
  path: string;
  line: number;
}

// Require a filename extension. This intentionally excludes URLs, ports and
// prose such as "section: 2", while accepting relative and Windows paths.
const FILE_LINE =
  /(^|[^A-Za-z\d_./\\:-])((?:(?:[A-Za-z]:)?[\\/])?[\w@#$%+.,()[\]/\\-][\w@#$%+.,()[\] /\\-]*\.[A-Za-z\d]{1,12}):(\d+)(?::\d+)?(?=$|[^A-Za-z\d_])/gm;

/** Extract safe `path:line` references from an agent answer. */
export function answerReferences(answer: string, workspaceRoot: string | null): AnswerReference[] {
  if (!workspaceRoot) return [];
  const references: AnswerReference[] = [];
  for (const match of answer.matchAll(FILE_LINE)) {
    const rawPath = match[2];
    const line = Number(match[3]);
    const path = resolveWorkspacePath(workspaceRoot, rawPath);
    if (!path || !Number.isSafeInteger(line) || line < 1) continue;
    const prefixLength = match[1]?.length ?? 0;
    const start = (match.index ?? 0) + prefixLength;
    references.push({
      start,
      end: start + rawPath.length + 1 + match[3].length,
      path,
      line,
    });
  }
  return references;
}
