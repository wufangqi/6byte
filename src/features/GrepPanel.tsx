import { useEffect, useRef, useState } from "react";
import { localizeError } from "../i18n";
import { useI18n } from "../i18n";
import { grepFiles, pickDirectory } from "../ipc/api";
import type { GrepResponse } from "../ipc/types";

interface Props {
  /** Directory of the active tab, used as the initial search root. */
  defaultRoot: string | null;
  onClose(): void;
  onOpenMatch(path: string, line: number): void;
}

/** Cross-file search panel (Ctrl+Shift+F), backed by Rust `regex`. */
export default function GrepPanel({ defaultRoot, onClose, onOpenMatch }: Props) {
  const [root, setRoot] = useState<string | null>(defaultRoot);
  const [pattern, setPattern] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<GrepResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { t, tp } = useI18n();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const chooseRoot = async () => {
    try {
      const directory = await pickDirectory();
      if (directory) setRoot(directory);
    } catch (e) {
      setError(localizeError(e));
    }
  };

  const run = async () => {
    if (!root) {
      setError(t("grep.needRoot"));
      return;
    }
    if (!pattern.trim()) {
      setError(t("grep.needPattern"));
      return;
    }

    setRunning(true);
    setError(null);
    try {
      setResult(await grepFiles(root, pattern, caseSensitive));
    } catch (e) {
      setResult(null);
      setError(localizeError(e));
    } finally {
      setRunning(false);
    }
  };

  const stats = result
    ? t("grep.stats", {
        files: tp("grep.files", result.filesMatched, { count: result.filesMatched }),
        matches: tp("grep.matches", result.matches.length, { count: result.matches.length }),
        scanned: tp("grep.scanned", result.filesScanned, { count: result.filesScanned }),
        ms: result.elapsedMs,
      })
    : "";

  return (
    <div className="grep-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="grep"
        role="dialog"
        aria-modal="true"
        aria-label={t("grep.title")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="grep__header">
          <span className="grep__title">{t("grep.title")}</span>
          <button
            type="button"
            className="grep__root"
            title={t("grep.chooseRootTitle")}
            onClick={() => void chooseRoot()}
          >
            {root ?? t("grep.chooseRoot")}
          </button>
          <button
            type="button"
            className="grep__close"
            aria-label={t("grep.close")}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <form
          className="grep__form"
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <input
            ref={inputRef}
            className="grep__input"
            value={pattern}
            placeholder={t("grep.placeholder")}
            aria-label={t("grep.inputLabel")}
            onChange={(event) => setPattern(event.target.value)}
          />
          <label className="grep__case">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(event) => setCaseSensitive(event.target.checked)}
            />
            {t("grep.case")}
          </label>
          <button type="submit" className="btn btn--primary" disabled={running}>
            {running ? t("grep.searching") : t("grep.search")}
          </button>
        </form>

        {error && <div className="grep__error">{error}</div>}

        {result && (
          <>
            <div className="grep__stats">
              {stats}
              {result.truncated ? t("grep.truncated") : ""}
            </div>
            <ul className="grep__results">
              {result.matches.map((match) => (
                <li key={`${match.path}:${match.line}:${match.column}`}>
                  <button
                    type="button"
                    className="grep__result"
                    onClick={() => onOpenMatch(match.path, match.line)}
                    title={`${match.path}:${match.line}`}
                  >
                    <span className="grep__path">{match.path}</span>
                    <span className="grep__line">
                      {match.line}:{match.column}
                    </span>
                    <span className="grep__snippet">{match.text}</span>
                  </button>
                </li>
              ))}
              {result.matches.length === 0 && <li className="grep__empty">{t("grep.empty")}</li>}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
