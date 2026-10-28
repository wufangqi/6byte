import { useI18n } from "../i18n";
import { CopyAction, IconAction } from "./AiPanelParts";
import { answerReferences } from "./answerLinks";

interface Props {
  answer: string;
  workspaceRoot: string | null;
  onOpenMatch(path: string, line: number): void;
  onInsert(): void;
  onConvertToRewrite(): void;
}

/** Render an answer with safe file/line navigation and explicit next actions. */
export default function AgentAnswer({
  answer,
  workspaceRoot,
  onOpenMatch,
  onInsert,
  onConvertToRewrite,
}: Props) {
  const { t } = useI18n();
  const references = answerReferences(answer, workspaceRoot);

  return (
    <div className="agent-answer">
      <p className="ai-stream__answer">
        {references.map((reference, index) => {
          const label = answer.slice(reference.start, reference.end);
          const before = answer.slice(references[index - 1]?.end ?? 0, reference.start);
          return (
            <span key={`${reference.start}-${reference.end}`}>
              {before}
              <button
                type="button"
                className="agent-answer__link"
                onClick={() => onOpenMatch(reference.path, reference.line)}
              >
                {label}
              </button>
              {index === references.length - 1 ? answer.slice(reference.end) : null}
            </span>
          );
        })}
        {references.length === 0 ? answer : null}
      </p>
      <div className="ai-stream__reply-actions">
        <CopyAction text={answer} />
        <IconAction icon="insert" label={t("ai.answer.insert")} onClick={onInsert} />
        <IconAction icon="rewrite" label={t("ai.answer.toRewrite")} onClick={onConvertToRewrite} />
      </div>
    </div>
  );
}
