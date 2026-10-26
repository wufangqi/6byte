import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { localizeError, useI18n } from "../i18n";
import { revealInOs } from "../ipc/api";
import {
  pageRows,
  TREE_PAGE_SIZE,
  treeHighlights,
  visibleTreeRows,
  type TreeNode,
} from "./fileTree";
import { selectActiveTab, useWorkspace } from "../stores/workspace";
import { useFileTree } from "../stores/fileTree";

interface Props {
  width: number;
  onOpenFile(path: string): void;
}

interface MenuState {
  x: number;
  y: number;
  path: string;
  kind: "dir" | "file";
}

/** Read-only workspace tree. One root, children loaded the first time a directory opens. */
export default function FileTree({ width, onOpenFile }: Props) {
  const { t } = useI18n();
  const root = useFileTree((state) => state.root);
  const rootPath = useFileTree((state) => state.rootPath);
  const rootName = useFileTree((state) => state.rootName);
  const selectedPath = useFileTree((state) => state.selectedPath);
  const focusRequest = useFileTree((state) => state.focusRequest);
  const activePath = useWorkspace((state) => selectActiveTab(state)?.path ?? null);
  const [shown, setShown] = useState(TREE_PAGE_SIZE);
  const [shownFor, setShownFor] = useState(rootPath);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);

  if (shownFor !== rootPath) {
    setShownFor(rootPath);
    setShown(TREE_PAGE_SIZE);
  }

  useEffect(() => {
    if (focusRequest === 0) return;
    const selected = treeRef.current?.querySelector<HTMLElement>("[tabindex='0']");
    (selected ?? treeRef.current)?.focus();
  }, [focusRequest]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  if (!root || !rootPath) return null;

  const rows = visibleTreeRows(root.children);
  const visible = pageRows(rows, shown);
  const selectedIndex = Math.max(
    0,
    rows.findIndex((row) => row.node.path === selectedPath)
  );

  const focusRow = (path: string) => {
    requestAnimationFrame(() => {
      treeRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.focus();
    });
  };

  const move = (index: number) => {
    const row = rows[index];
    if (!row) return;
    useFileTree.getState().select(row.node.path);
    if (index >= shown) setShown(index + 1);
    focusRow(row.node.path);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const key = event.key;
    if (
      ![
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Enter",
        "Home",
        "End",
        "Escape",
      ].includes(key)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const current = rows[selectedIndex]?.node;
    if (key === "Escape") {
      document.querySelector<HTMLElement>(".cm-content")?.focus();
      return;
    }
    if (key === "ArrowDown") move(Math.min(rows.length - 1, selectedIndex + 1));
    else if (key === "ArrowUp") move(Math.max(0, selectedIndex - 1));
    else if (key === "Home") move(0);
    else if (key === "End") move(rows.length - 1);
    else if (key === "Enter" && current) {
      if (current.kind === "file") onOpenFile(current.path);
      else void useFileTree.getState().toggleDir(current.path);
    } else if (key === "ArrowRight" && current?.kind === "dir") {
      if (!current.expanded) void useFileTree.getState().toggleDir(current.path);
      else if (current.children?.[0]) {
        useFileTree.getState().select(current.children[0].path);
        focusRow(current.children[0].path);
      }
    } else if (key === "ArrowLeft" && current) {
      if (current.kind === "dir" && current.expanded)
        void useFileTree.getState().toggleDir(current.path);
      else {
        const parent = rows
          .slice(0, selectedIndex)
          .reverse()
          .find((row) => row.depth < (rows[selectedIndex]?.depth ?? 0));
        if (parent) {
          useFileTree.getState().select(parent.node.path);
          focusRow(parent.node.path);
        }
      }
    }
  };

  const openMenu = (event: ReactMouseEvent, node: TreeNode) => {
    event.preventDefault();
    useFileTree.getState().select(node.path);
    setMenu({ x: event.clientX, y: event.clientY, path: node.path, kind: node.kind });
  };

  return (
    <aside className="file-tree" style={{ width }} aria-label={t("tree.title")}>
      <div className="file-tree__head">
        <div className="file-tree__titles">
          <div className="file-tree__name">{rootName}</div>
          <div className="file-tree__path" title={rootPath}>
            {rootPath}
          </div>
        </div>
        <button
          type="button"
          className="file-tree__icon"
          aria-label={t("tree.refresh")}
          title={t("tree.refresh")}
          onClick={() => void useFileTree.getState().refresh()}
        >
          ↻
        </button>
        <button
          type="button"
          className="file-tree__icon file-tree__close"
          aria-label={t("tree.close")}
          title={t("tree.close")}
          onClick={() => useFileTree.getState().closeRoot()}
        >
          ×
        </button>
      </div>
      <div
        className="file-tree__body"
        ref={treeRef}
        role="tree"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {root.state === "loading" && <p className="file-tree__status">{t("tree.loading")}</p>}
        {root.state === "error" && (
          <p className="file-tree__status">
            {root.error || t("tree.loadError")}
            <button type="button" onClick={() => void useFileTree.getState().retryDir(root.path)}>
              {t("tree.retry")}
            </button>
          </p>
        )}
        {root.state === "ready" && rows.length === 0 && (
          <p className="file-tree__status">{t("tree.empty")}</p>
        )}
        {visible.map((row) => {
          const { node, depth } = row;
          const selected = node.path === selectedPath;
          const active = treeHighlights(rootPath, activePath, node.path);
          const selectedVisible = visible.some((item) => item.node.path === selectedPath);
          return (
            <div key={node.path}>
              <div
                className={`file-tree__row${selected ? " file-tree__row--selected" : ""}${active ? " file-tree__row--active" : ""}`}
                role="treeitem"
                aria-expanded={node.kind === "dir" ? Boolean(node.expanded) : undefined}
                aria-selected={selected || active}
                data-name={node.name}
                data-path={node.path}
                title={node.path}
                tabIndex={selected || (!selectedVisible && row === visible[0]) ? 0 : -1}
                style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => {
                  useFileTree.getState().select(node.path);
                  if (node.kind === "file") onOpenFile(node.path);
                }}
                onDoubleClick={() => {
                  if (node.kind === "dir") void useFileTree.getState().toggleDir(node.path);
                }}
                onContextMenu={(event) => openMenu(event, node)}
                onFocus={() => useFileTree.getState().select(node.path)}
              >
                {node.kind === "dir" ? (
                  <button
                    type="button"
                    className="file-tree__twist"
                    aria-label={node.expanded ? t("tree.collapse") : t("tree.expand")}
                    onClick={(event) => {
                      event.stopPropagation();
                      void useFileTree.getState().toggleDir(node.path);
                    }}
                  >
                    {node.state === "loading" ? "…" : node.expanded ? "▼" : "▶"}
                  </button>
                ) : (
                  <span className="file-tree__twist file-tree__twist--file" aria-hidden="true" />
                )}
                <span className="file-tree__label">{node.name}</span>
              </div>
              {node.kind === "dir" && node.expanded && node.truncated && (
                <div className="file-tree__note" style={{ paddingLeft: 28 + depth * 14 }}>
                  {t("tree.truncated", { limit: node.limit ?? 2000 })}
                </div>
              )}
              {node.kind === "dir" && node.state === "error" && (
                <div className="file-tree__note" style={{ paddingLeft: 28 + depth * 14 }}>
                  {t("tree.loadError")}
                  <button
                    type="button"
                    onClick={() => void useFileTree.getState().retryDir(node.path)}
                  >
                    {t("tree.retry")}
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {rows.length > shown && (
          <button
            type="button"
            className="file-tree__more"
            onClick={() => setShown((value) => value + TREE_PAGE_SIZE)}
          >
            {t("tree.showMore")}
          </button>
        )}
      </div>
      {menu && (
        <div
          className="menu file-tree__menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="menu__item"
            onClick={() => {
              if (menu.kind === "file") onOpenFile(menu.path);
              else void useFileTree.getState().toggleDir(menu.path);
              setMenu(null);
            }}
          >
            {t("tree.open")}
          </button>
          <button
            type="button"
            className="menu__item"
            onClick={() => {
              void revealInOs(menu.path).catch((error) =>
                useWorkspace.getState().setError(localizeError(error))
              );
              setMenu(null);
            }}
          >
            {t("tree.reveal")}
          </button>
          <button
            type="button"
            className="menu__item"
            onClick={() => {
              void navigator.clipboard?.writeText(menu.path).then(() => {
                useWorkspace.getState().setNotice(t("tree.copied"));
              });
              setMenu(null);
            }}
          >
            {t("tree.copyPath")}
          </button>
        </div>
      )}
    </aside>
  );
}
