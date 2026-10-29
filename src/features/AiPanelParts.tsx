import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import type { AskStep, Conversation, RewriteEntry, UserEntry } from "./aiHistory";
import { AppLogo } from "./MenuBar";
import RewriteReviewPanel from "./RewriteReviewPanel";
import {
  acceptedRewriteCount,
  acceptedRewriteText,
  createRewriteReview,
  rewriteHunks,
  updateRewriteHunk,
  type RewriteReview,
} from "./rewriteReview";

export type PanelIconKind =
  | "history"
  | "newChat"
  | "close"
  | "at"
  | "layers"
  | "send"
  | "stop"
  | "chevron"
  | "copy"
  | "insert"
  | "rewrite"
  | "check"
  | "search"
  | "list"
  | "folder"
  | "file"
  | "text"
  | "down"
  | "trash";

export function PanelIcon({ kind, size = 16 }: { kind: PanelIconKind; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "history" && (
        <>
          <path d="M2.2 8a5.8 5.8 0 1 0 1.8-4.2L2.2 5.5" />
          <path d="M2.2 2.5v3h3M8 5v3l2 1.3" />
        </>
      )}
      {kind === "newChat" && (
        <>
          <path d="M13.8 8A5.8 5.8 0 0 1 5.4 13.2L2.2 14l.8-3A5.8 5.8 0 1 1 13.8 8z" />
          <path d="M8 5.6v4.8M5.6 8h4.8" />
        </>
      )}
      {kind === "close" && <path d="M4 4l8 8M12 4l-8 8" />}
      {kind === "at" && (
        <>
          <circle cx="8" cy="8" r="2.4" />
          <path d="M10.4 5.6v3a1.7 1.7 0 0 0 3.4 0V8a5.8 5.8 0 1 0-2.3 4.6" />
        </>
      )}
      {kind === "layers" && (
        <>
          <path d="M8 2l6 3.2-6 3.2-6-3.2z" />
          <path d="M2 8.6l6 3.2 6-3.2" />
        </>
      )}
      {kind === "send" && <path d="M8 13V3M3.8 7.2L8 3l4.2 4.2" strokeWidth="1.7" />}
      {kind === "stop" && (
        <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none" />
      )}
      {kind === "chevron" && <path d="M6 3.8L10.2 8 6 12.2" />}
      {kind === "copy" && (
        <>
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.4" />
          <path d="M3.2 10.5H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.2" />
        </>
      )}
      {kind === "insert" && <path d="M8 2.5v7.5M4.8 6.8L8 10l3.2-3.2M3 13.5h10" />}
      {kind === "rewrite" && (
        <>
          <path d="M2.5 13.5l7.5-7.5M9.2 3.8l3 3" />
          <path d="M11.5 1.8v1.6M13.8 4.5h-1.6M12.9 2.4l-.9.9" />
        </>
      )}
      {kind === "check" && <path d="M3.2 8.4l3 3 6.6-6.8" />}
      {kind === "search" && (
        <>
          <circle cx="7" cy="7" r="4.3" />
          <path d="M13.5 13.5l-3.4-3.4" />
        </>
      )}
      {kind === "list" && <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />}
      {kind === "folder" && (
        <path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
      )}
      {kind === "file" && (
        <>
          <path d="M9.5 2H4.5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5z" />
          <path d="M9.5 2v3h3" />
        </>
      )}
      {kind === "text" && <path d="M3 4.8V3h10v1.8M8 3v10M6 13h4" />}
      {kind === "down" && <path d="M8 3v10M3.8 8.8L8 13l4.2-4.2" />}
      {kind === "trash" && (
        <>
          <path d="M2.8 4.2h10.4M6.2 4.2V2.8h3.6v1.4M4.2 4.2l.6 9h6.4l.6-9" />
        </>
      )}
    </svg>
  );
}

export function UserBubble({ entry }: { entry: UserEntry }) {
  return (
    <div className="ai-stream__user">
      {entry.chips.map((chip) => (
        <span key={`${chip.kind}-${chip.label}`} className="ai-stream__chip">
          <PanelIcon kind={chip.kind === "file" ? "file" : "text"} size={12} />
          <span>{chip.label}</span>
        </span>
      ))}
      {entry.text && <span className="ai-stream__user-text">{entry.text}</span>}
    </div>
  );
}

export function BotHeader({ model }: { model: string }) {
  const { t } = useI18n();
  return (
    <div className="ai-stream__who">
      <AppLogo className="ai-stream__avatar" />
      <span>{t("ai.panel.assistant")}</span>
      {model && <span className="ai-stream__who-model">{model}</span>}
    </div>
  );
}

/** One-line summary of the work behind a reply. Details stay folded until asked for. */
export function ProcessRow({
  label,
  live,
  open,
  onToggle,
  children,
}: {
  label: string;
  live?: boolean;
  open: boolean;
  onToggle(): void;
  children?: ReactNode;
}) {
  const expandable = Boolean(children);
  return (
    <div className="ai-stream__process-wrap">
      <button
        type="button"
        className={`ai-stream__process${live ? " is-live" : ""}${open ? " is-open" : ""}`}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={onToggle}
      >
        {expandable && <PanelIcon kind="chevron" size={12} />}
        {live && <span className="ai-stream__spinner" aria-hidden="true" />}
        <span>{label}</span>
      </button>
      {expandable && open && <div className="ai-stream__process-body">{children}</div>}
    </div>
  );
}

const TRACE_TOOLS: Record<string, { icon: "search" | "list" | "folder" | "file"; label: string }> =
  {
    grep: { icon: "search", label: "ai.trace.grep" },
    outline: { icon: "list", label: "ai.trace.outline" },
    list_dir: { icon: "folder", label: "ai.trace.listDir" },
    read_range: { icon: "file", label: "ai.trace.readRange" },
  };

export function TraceList({ steps, live }: { steps: AskStep[]; live?: boolean }) {
  const { t } = useI18n();
  return (
    <ol className="ai-stream__trace">
      {steps.map((step, index) => {
        const tool = TRACE_TOOLS[step.name];
        return (
          <li key={`${step.name}-${index}`}>
            <span className="ai-stream__trace-done">
              <PanelIcon kind={tool ? "check" : "close"} size={12} />
            </span>
            <PanelIcon kind={tool?.icon ?? "search"} size={12} />
            <span>{tool ? t(tool.label) : step.name}</span>
            {step.detail && <code>{step.detail}</code>}
          </li>
        );
      })}
      {live && (
        <li className="is-live">
          <span className="ai-stream__spinner" aria-hidden="true" />
          <span>{t("ai.panel.looking")}</span>
        </li>
      )}
    </ol>
  );
}

export function IconAction({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: PanelIconKind;
  label: string;
  onClick(): void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="ai-stream__icon ai-stream__icon--small"
      aria-label={label}
      data-tip={label}
      disabled={disabled}
      onClick={onClick}
    >
      <PanelIcon kind={icon} size={14} />
    </button>
  );
}

export function CopyAction({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <IconAction
      icon={copied ? "check" : "copy"}
      label={copied ? t("ai.panel.copied") : t("ai.panel.copy")}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          })
          .catch(() => {});
      }}
    />
  );
}

function clipSame(text: string): string {
  const compact = text.replace(/\n+$/, "");
  if (compact.length <= 80) return compact;
  return `${compact.slice(0, 36)} … ${compact.slice(-36)}`;
}

/** Inline diff of the proposal against the original selection. */
function DiffPreview({ original, text }: { original: string; text: string }) {
  const review = createRewriteReview(original, text);
  return (
    <div className="ai-stream__diff">
      {review.parts.map((part, index) =>
        part.kind === "same" ? (
          <span key={index} className="ai-stream__diff-same">
            {clipSame(part.text)}
          </span>
        ) : (
          <span key={part.hunk.id} className="ai-stream__diff-change">
            {part.hunk.original && <del>{part.hunk.original.replace(/\n$/, "")}</del>}
            {part.hunk.replacement && <ins>{part.hunk.replacement.replace(/\n$/, "")}</ins>}
          </span>
        )
      )}
    </div>
  );
}

/**
 * A rewrite turn. Only the pending card can change the document; every other
 * state is a read-only record of what was proposed.
 */
export function RewriteCard({
  entry,
  version,
  liveText,
  onAccept,
  onDiscard,
  onReviewChange,
}: {
  entry: RewriteEntry;
  version: number;
  /** Streaming text while the entry is live. */
  liveText?: string;
  onAccept(text?: string): void;
  onDiscard(): void;
  /** Null when this card is not choosing blocks. Tab follows the same choice. */
  onReviewChange?(review: RewriteReview | null): void;
}) {
  const { t } = useI18n();
  const [review, setReview] = useState<RewriteReview | null>(null);
  const pending = entry.status === "pending";
  const live = entry.status === "live";
  const text = live ? (liveText ?? "") : entry.text;
  const hunks = pending ? rewriteHunks(createRewriteReview(entry.original, entry.text)) : [];
  const accepted = acceptedRewriteCount(review);

  useEffect(() => {
    if (!onReviewChange || entry.status !== "pending") return;
    onReviewChange(review);
    return () => onReviewChange(null);
  }, [entry.status, onReviewChange, review]);

  return (
    <div className={`ai-stream__card is-${entry.status}`}>
      <div className="ai-stream__card-head">
        <strong>{t("ai.panel.version", { count: version })}</strong>
        {pending && hunks.length > 0 && (
          <span>{t("ai.panel.changes", { count: hunks.length })}</span>
        )}
        <span className="ai-stream__card-state">{t(`ai.panel.status.${entry.status}`)}</span>
      </div>
      <div className="ai-stream__card-body">
        {entry.status === "failed" ? (
          <p className="ai-stream__card-error">{entry.error || t("ai.stream.empty")}</p>
        ) : pending && !review ? (
          <DiffPreview original={entry.original} text={entry.text} />
        ) : pending && review ? (
          <RewriteReviewPanel
            review={review}
            onDecide={(id, yes) =>
              setReview((current) =>
                current ? updateRewriteHunk(current, id, yes ? "accepted" : "discarded") : current
              )
            }
          />
        ) : text ? (
          <p className={`ai-stream__card-text${live ? "" : " is-clamped"}`}>{text}</p>
        ) : (
          <p className="ai-stream__card-text is-muted">
            {live ? t("ai.panel.writing") : t("ai.stream.empty")}
          </p>
        )}
      </div>
      {pending && (
        <div className="ai-stream__card-actions">
          {review ? (
            <>
              <button
                type="button"
                className="btn btn--primary"
                disabled={accepted === 0}
                onClick={() => onAccept(acceptedRewriteText(review))}
              >
                {t("ai.review.applyAccepted", { count: accepted })}
              </button>
              <button type="button" className="btn" onClick={() => setReview(null)}>
                {t("ai.panel.reviewClose")}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn--primary" onClick={() => onAccept()}>
                {t("ai.stream.acceptAll")}
              </button>
              {hunks.length > 1 && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => setReview(createRewriteReview(entry.original, entry.text))}
                >
                  {t("ai.panel.review")}
                </button>
              )}
              <button type="button" className="btn btn--ghost" onClick={onDiscard}>
                {t("ai.stream.discard")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function relativeTime(at: number, locale: string): string {
  const diff = Date.now() - at;
  const minute = 60_000;
  const rtf = new Intl.RelativeTimeFormat(locale === "zh" ? "zh-CN" : "en", { numeric: "auto" });
  if (diff < minute) return rtf.format(0, "minute");
  if (diff < 60 * minute) return rtf.format(-Math.round(diff / minute), "minute");
  if (diff < 24 * 60 * minute) return rtf.format(-Math.round(diff / (60 * minute)), "hour");
  if (diff < 7 * 24 * 60 * minute) return rtf.format(-Math.round(diff / (24 * 60 * minute)), "day");
  return new Date(at).toLocaleDateString(locale === "zh" ? "zh-CN" : "en");
}

export function HistoryList({
  items,
  currentId,
  disabled,
  onOpen,
  onRemove,
  onClear,
}: {
  items: Conversation[];
  currentId: string;
  disabled: boolean;
  onOpen(item: Conversation): void;
  onRemove(id: string): void;
  onClear(): void;
}) {
  const { t, locale } = useI18n();
  return (
    <div
      className="ai-stream__popover ai-stream__history"
      role="dialog"
      aria-label={t("ai.history.title")}
    >
      <div className="ai-stream__popover-title">
        <span>{t("ai.history.title")}</span>
        {items.length > 0 && (
          <button type="button" className="ai-stream__link" onClick={onClear}>
            {t("ai.history.clear")}
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="ai-stream__history-empty">{t("ai.history.empty")}</p>
      ) : (
        <ul className="ai-stream__history-list">
          {items.map((item) => (
            <li key={item.id} className={item.id === currentId ? "is-current" : undefined}>
              <button
                type="button"
                className="ai-stream__history-item"
                disabled={disabled}
                onClick={() => onOpen(item)}
              >
                <span className="ai-stream__history-name">
                  {item.title || t("ai.history.untitled")}
                </span>
                <span className="ai-stream__history-meta">
                  {item.id === currentId
                    ? t("ai.history.current")
                    : relativeTime(item.updatedAt, locale)}
                </span>
              </button>
              <button
                type="button"
                className="ai-stream__icon ai-stream__icon--small"
                aria-label={t("ai.history.remove")}
                title={t("ai.history.remove")}
                onClick={() => onRemove(item.id)}
              >
                <PanelIcon kind="trash" size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="ai-stream__popover-note">{t("ai.history.note")}</p>
    </div>
  );
}
