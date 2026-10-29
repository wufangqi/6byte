import { useEffect, useMemo, useRef, useState } from "react";
import { readBuffer } from "../editor/registry";
import { useI18n } from "../i18n";
import { listDirChildren } from "../ipc/api";
import { fileName } from "../lib/paths";
import { useFileTree } from "../stores/fileTree";
import { useWorkspace } from "../stores/workspace";
import { isMarkdownFile } from "./markdown";
import { extractHeadings } from "./outline";
import {
  collectWorkspaceFiles,
  filterPalette,
  flattenTreeFiles,
  relativePath,
  type PaletteItem,
} from "./workspaceQuery";

interface Props {
  onOpenFile(path: string): void;
  onRevealLine(line: number): void;
  onCommand?(id: string): void;
  onClose(): void;
}

/** Jump to a workspace file, a recent file, or a heading in the current document. */
export default function CommandPalette({ onOpenFile, onRevealLine, onCommand, onClose }: Props) {
  const { t } = useI18n();
  const root = useFileTree((state) => state.rootPath);
  const tree = useFileTree((state) => state.root);
  const recent = useWorkspace((state) => state.recent);
  const tab = useWorkspace(
    (state) => state.tabs.find((item) => item.id === state.activeId) ?? null
  );
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState(() => flattenTreeFiles(tree));
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!root) return;
    let cancel = false;
    void collectWorkspaceFiles(root, listDirChildren).then((listed) => {
      if (!cancel) setFiles(listed);
    });
    return () => {
      cancel = true;
    };
  }, [root]);

  const items = useMemo(() => {
    const commands: PaletteItem[] =
      tab?.mode === "text"
        ? [
            {
              id: "export-html",
              kind: "command",
              label: t("menu.exportHtml"),
              detail: t("command.exportHtml"),
            },
          ]
        : [];
    const outline: PaletteItem[] =
      tab && isMarkdownFile(tab.name)
        ? extractHeadings(readBuffer(tab.id, tab.content)).map((heading) => ({
            id: `heading:${heading.line}:${heading.text}`,
            kind: "heading" as const,
            label: heading.text,
            detail: `${"#".repeat(heading.level)} · ${t("command.outline")}`,
            line: heading.line,
          }))
        : [];
    const seen = new Set<string>();
    const fileItems: PaletteItem[] = [];
    for (const path of recent) {
      if (seen.has(path)) continue;
      seen.add(path);
      fileItems.push({
        id: `recent:${path}`,
        kind: "recent",
        label: fileName(path),
        detail: path,
        path,
      });
    }
    for (const file of files) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      fileItems.push({
        id: `file:${file.path}`,
        kind: "file",
        label: file.name,
        detail: root ? relativePath(root, file.path) : file.path,
        path: file.path,
      });
    }
    return filterPalette([...commands, ...outline, ...fileItems], query);
  }, [files, query, recent, root, t, tab]);

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    if (item.kind === "command") onCommand?.(item.id);
    else if (item.kind === "heading" && item.line) onRevealLine(item.line);
    else if (item.path) onOpenFile(item.path);
  };

  return (
    <div className="grep-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="command"
        role="dialog"
        aria-modal="true"
        aria-label={t("command.title")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="command__input"
          value={query}
          placeholder={t("command.placeholder")}
          aria-label={t("command.title")}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => Math.min(items.length - 1, index + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(0, index - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(items[active]);
            }
          }}
        />
        {items.length === 0 ? (
          <p className="command__empty">{root ? t("command.empty") : t("command.noWorkspace")}</p>
        ) : (
          <ul className="command__list" role="listbox">
            {items.map((item, index) => (
              <li key={item.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className={`command__item${index === active ? " is-on" : ""}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(item)}
                >
                  <span>{item.label}</span>
                  <span className="command__detail">{item.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
