import { useEffect, useRef, useState } from "react";
import { grepFiles, pickDirectory } from "../ipc/api";
import type { GrepResponse } from "../ipc/types";

interface Props {
  /** Directory of the active tab, used as the initial search root. */
  defaultRoot: string | null;
  onClose(): void;
  onOpenMatch(path: string, line: number): void;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Cross-file search panel (Ctrl+Shift+F), backed by Rust `regex`. */
export default function GrepPanel({ defaultRoot, onClose, onOpenMatch }: Props) {
  const [root, setRoot] = useState<string | null>(defaultRoot);
  const [pattern, setPattern] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<GrepResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

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
      setError(errorMessage(e));
    }
  };

  const run = async () => {
    if (!root) {
      setError("请先选择要搜索的文件夹。");
      return;
    }
    if (!pattern.trim()) {
      setError("搜索内容不能为空。");
      return;
    }

    setRunning(true);
    setError(null);
    try {
      setResult(await grepFiles(root, pattern, caseSensitive));
    } catch (e) {
      setResult(null);
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="grep-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="grep"
        role="dialog"
        aria-modal="true"
        aria-label="跨文件搜索"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="grep__header">
          <span className="grep__title">跨文件搜索</span>
          <button
            type="button"
            className="grep__root"
            title="点击更换搜索目录"
            onClick={() => void chooseRoot()}
          >
            {root ?? "选择文件夹…"}
          </button>
          <button type="button" className="grep__close" aria-label="关闭" onClick={onClose}>
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
            placeholder="正则表达式，例如 TODO|FIXME"
            aria-label="搜索内容"
            onChange={(event) => setPattern(event.target.value)}
          />
          <label className="grep__case">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(event) => setCaseSensitive(event.target.checked)}
            />
            区分大小写
          </label>
          <button type="submit" className="btn btn--primary" disabled={running}>
            {running ? "搜索中…" : "搜索"}
          </button>
        </form>

        {error && <div className="grep__error">{error}</div>}

        {result && (
          <>
            <div className="grep__stats">
              {result.filesMatched} 个文件 · {result.matches.length} 处匹配 · 扫描{" "}
              {result.filesScanned} 个文件 · {result.elapsedMs} ms
              {result.truncated ? " · 结果已截断" : ""}
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
              {result.matches.length === 0 && <li className="grep__empty">没有匹配</li>}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
