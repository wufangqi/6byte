import { useCallback, useEffect, useRef, useState } from "react";
import { localizeError, useI18n } from "../i18n";
import { readRange } from "../ipc/api";
import { formatSize } from "../lib/format";
import { useWorkspace, type Tab } from "../stores/workspace";
import { LINE_HEIGHT, WINDOW_LINES, needsFetch, windowStartFor } from "./largeFile";

/**
 * Read-only windowed viewer used for L2 files (20–100 MB). Only the visible
 * slice is fetched from Rust, so opening a 100 MB log stays cheap.
 */
export default function LargeFileViewer({ tab }: { tab: Tab }) {
  const [windowStart, setWindowStart] = useState(0);
  const [lines, setLines] = useState<string[]>([]);
  const { t, tp } = useI18n();

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const totalLines = tab.lines;

  const load = useCallback(
    async (startLine: number) => {
      if (!tab.path || inFlight.current) return;
      const total = Math.max(totalLines, 1);
      const from = Math.max(0, Math.min(startLine, Math.max(0, total - WINDOW_LINES)));
      const to = Math.min(total, from + WINDOW_LINES);

      inFlight.current = true;
      try {
        const range = await readRange(tab.path, from, to);
        if (!mounted.current) return;
        setWindowStart(range.startLine);
        setLines(range.lines);
      } catch (error) {
        if (mounted.current) {
          useWorkspace.getState().setError(localizeError(error));
        }
      } finally {
        inFlight.current = false;
      }
    },
    [tab.path, totalLines]
  );

  useEffect(() => {
    mounted.current = true;
    // Defer the first fetch so the effect itself never triggers a state update.
    const timer = window.setTimeout(() => void load(0), 0);
    return () => {
      mounted.current = false;
      window.clearTimeout(timer);
    };
  }, [load]);

  const onScroll = () => {
    const scrollTop = scrollerRef.current?.scrollTop ?? 0;
    if (needsFetch(scrollTop, windowStart, lines.length, totalLines)) {
      void load(windowStartFor(scrollTop, totalLines));
    }
  };

  return (
    <div className="viewer">
      <div className="viewer__notice">
        <span className="viewer__badge">{t("viewer.badge")}</span>
        <span>
          {t("viewer.notice", {
            size: formatSize(tab.size),
            lines: tp("viewer.lines", totalLines, { count: totalLines }),
          })}
        </span>
        {lines.length === 0 && <span className="viewer__loading">{t("viewer.loading")}</span>}
      </div>

      <div className="viewer__scroller" ref={scrollerRef} onScroll={onScroll}>
        <div className="viewer__canvas" style={{ height: totalLines * LINE_HEIGHT }}>
          <div className="viewer__window" style={{ top: windowStart * LINE_HEIGHT }}>
            {lines.map((line, index) => (
              <div className="viewer__line" key={windowStart + index}>
                <span className="viewer__num">{windowStart + index + 1}</span>
                <span className="viewer__text">{line || "\u00a0"}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
