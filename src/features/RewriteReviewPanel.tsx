import { useI18n } from "../i18n";
import type { RewriteReview as Review } from "./rewriteReview";
import { rewriteHunks } from "./rewriteReview";

interface Props {
  review: Review;
  onDecide(id: string, accepted: boolean): void;
}

/** A compact, explicit diff review. The document remains unchanged until apply. */
export default function RewriteReviewPanel({ review, onDecide }: Props) {
  const { t } = useI18n();
  const hunks = rewriteHunks(review);
  if (hunks.length === 0) return null;

  return (
    <section className="rewrite-review" aria-label={t("ai.review.title")}>
      <div className="rewrite-review__head">
        <strong>{t("ai.review.title")}</strong>
        <span>{t("ai.review.hint")}</span>
      </div>
      <ol className="rewrite-review__list">
        {hunks.map((hunk, index) => (
          <li key={hunk.id} className={`rewrite-review__hunk is-${hunk.state}`}>
            <div className="rewrite-review__hunk-head">
              <strong>{t("ai.review.block", { count: index + 1 })}</strong>
              <span>{t(`ai.review.${hunk.state}`)}</span>
            </div>
            <div className="rewrite-review__diff">
              <pre className="rewrite-review__original">
                {hunk.original || t("ai.review.empty")}
              </pre>
              <pre className="rewrite-review__replacement">
                {hunk.replacement || t("ai.review.empty")}
              </pre>
            </div>
            <div className="rewrite-review__actions">
              <button
                type="button"
                className="btn btn--primary"
                aria-pressed={hunk.state === "accepted"}
                onClick={() => onDecide(hunk.id, true)}
              >
                {t("ai.review.acceptBlock")}
              </button>
              <button
                type="button"
                className="btn"
                aria-pressed={hunk.state === "discarded"}
                onClick={() => onDecide(hunk.id, false)}
              >
                {t("ai.review.keepOriginal")}
              </button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
