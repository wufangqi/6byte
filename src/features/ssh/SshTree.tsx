/**
 * Lazy-loading remote file tree for an SSH session.
 *
 * Expanding a directory fetches its children via `ssh_list_dir`. Double-click
 * opens a file in the editor. Right-click shows a context menu with
 * new/rename/delete/upload/download.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { localizeError, useI18n } from "../../i18n";
import { isTauri } from "../../ipc/api";
import {
  sshCreateFile,
  sshDelete,
  sshDownload,
  sshMkdir,
  sshReadFile,
  sshRename,
  sshUpload,
} from "../../ipc/ssh";
import { ask } from "../dialogStore";
import { askName } from "../renamePrompt";
import { tabFromFile, useWorkspace } from "../../stores/workspace";
import { useSshStore, type SshTreeNode } from "../../stores/ssh";
import { buildSshUri, posixJoin, posixParentDir } from "./remotePath";

interface Props {
  profileId: string;
  homePath: string;
}

interface MenuState {
  x: number;
  y: number;
  node: SshTreeNode;
}

export default function SshTree({ profileId, homePath }: Props) {
  const { t } = useI18n();
  const tree = useSshStore((s) => s.trees.get(profileId));
  const expandDir = useSshStore((s) => s.expandDir);
  const invalidatePath = useSshStore((s) => s.invalidatePath);
  const [jumpPath, setJumpPath] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);

  // Initialize root on first render if not yet loaded.
  useEffect(() => {
    if (!tree && homePath) {
      void expandDir(profileId, homePath);
    }
  }, [profileId, homePath, tree, expandDir]);

  // Close context menu on outside click.
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

  const toggleDir = useCallback(
    (node: SshTreeNode) => {
      if (node.kind !== "dir") return;
      if (node.loaded) {
        // Collapse by clearing loaded flag — next expand re-fetches.
        invalidatePath(profileId, node.path);
      } else {
        void expandDir(profileId, node.path);
      }
    },
    [profileId, expandDir, invalidatePath]
  );

  const openFile = useCallback(
    async (node: SshTreeNode) => {
      if (node.kind !== "file") return;
      try {
        const file = await sshReadFile(profileId, node.path);
        useWorkspace.getState().addTab(tabFromFile(file));
      } catch (e) {
        useWorkspace.getState().setError(localizeError(e));
      }
    },
    [profileId]
  );

  const handleContextMenu = useCallback((e: ReactMouseEvent, node: SshTreeNode) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  const handleJump = useCallback(
    async (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      const path = jumpPath.trim();
      if (!path) return;
      try {
        const file = await sshReadFile(profileId, path);
        useWorkspace.getState().addTab(tabFromFile(file));
      } catch (err) {
        // Might be a directory — try expanding it.
        try {
          await expandDir(profileId, path);
        } catch {
          useWorkspace.getState().setError(localizeError(err));
        }
      }
    },
    [profileId, jumpPath, expandDir]
  );

  // Context menu actions
  const ctxNewFile = useCallback(
    async (dirPath: string) => {
      const name = await askName({
        title: t("ssh.tree.newFile.title"),
        label: t("ssh.tree.newFile.label"),
        initial: "",
        confirmLabel: t("ssh.connect.save"),
        cancelLabel: t("ssh.connect.cancel"),
      });
      if (!name) return;
      try {
        await sshCreateFile(profileId, posixJoin(dirPath, name));
        invalidatePath(profileId, dirPath);
        void expandDir(profileId, dirPath);
      } catch (e) {
        useWorkspace.getState().setError(localizeError(e));
      }
    },
    [profileId, t, invalidatePath, expandDir]
  );

  const ctxNewFolder = useCallback(
    async (dirPath: string) => {
      const name = await askName({
        title: t("ssh.tree.newFolder.title"),
        label: t("ssh.tree.newFolder.label"),
        initial: "",
        confirmLabel: t("ssh.connect.save"),
        cancelLabel: t("ssh.connect.cancel"),
      });
      if (!name) return;
      try {
        await sshMkdir(profileId, posixJoin(dirPath, name));
        invalidatePath(profileId, dirPath);
        void expandDir(profileId, dirPath);
      } catch (e) {
        useWorkspace.getState().setError(localizeError(e));
      }
    },
    [profileId, t, invalidatePath, expandDir]
  );

  const ctxRename = useCallback(
    async (node: SshTreeNode) => {
      const name = await askName({
        title: t("ssh.tree.rename.title"),
        label: t("ssh.tree.rename.label"),
        initial: node.name,
        confirmLabel: t("tab.rename.confirm"),
        cancelLabel: t("ssh.connect.cancel"),
      });
      if (!name || name === node.name) return;
      try {
        await sshRename(profileId, node.path, name);
        const parent = posixParentDir(node.path);
        if (parent) {
          invalidatePath(profileId, parent);
          void expandDir(profileId, parent);
        }
      } catch (e) {
        useWorkspace.getState().setError(localizeError(e));
      }
    },
    [profileId, t, invalidatePath, expandDir]
  );

  const ctxDelete = useCallback(
    async (node: SshTreeNode) => {
      const choice = await ask({
        title: t("ssh.tree.delete.confirm.title"),
        message: t("ssh.tree.delete.confirm.message", { name: node.name }),
        buttons: [
          { label: t("ssh.connect.cancel"), value: "cancel" },
          { label: t("ssh.tree.ctx.delete"), value: "delete", variant: "danger" },
        ],
      });
      if (choice !== "delete") return;
      try {
        await sshDelete(profileId, node.path);
        const parent = posixParentDir(node.path);
        if (parent) {
          invalidatePath(profileId, parent);
          void expandDir(profileId, parent);
        }
      } catch (e) {
        useWorkspace.getState().setError(localizeError(e));
      }
    },
    [profileId, t, invalidatePath, expandDir]
  );

  const ctxUpload = useCallback(
    async (dirPath: string) => {
      if (!isTauri) return;
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({ multiple: false, directory: false });
        if (!selected) return;
        const localPath = Array.isArray(selected) ? selected[0] : selected;
        if (!localPath) return;
        await sshUpload(profileId, localPath, dirPath);
        invalidatePath(profileId, dirPath);
        void expandDir(profileId, dirPath);
      } catch (e) {
        useWorkspace.getState().setError(localizeError(e));
      }
    },
    [profileId, invalidatePath, expandDir]
  );

  const ctxDownload = useCallback(
    async (node: SshTreeNode) => {
      if (!isTauri) return;
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const localPath = await save({ defaultPath: node.name });
        if (!localPath) return;
        await sshDownload(profileId, node.path, localPath);
      } catch (e) {
        useWorkspace.getState().setError(localizeError(e));
      }
    },
    [profileId]
  );

  const ctxCopyPath = useCallback(
    (node: SshTreeNode) => {
      const uri = buildSshUri(profileId, node.path);
      void navigator.clipboard.writeText(uri);
    },
    [profileId]
  );

  if (!tree) {
    return (
      <div className="ssh-tree ssh-tree--empty">
        <span className="ssh-tree__loading">{t("ssh.tree.loading")}</span>
      </div>
    );
  }

  // The root node is implicit (it is not drawn as a row), so its own
  // loading/error state has to be surfaced here or a failed first listing
  // would look like an endless spinner.
  if (tree.loading && !tree.loaded && tree.children.length === 0) {
    return (
      <div className="ssh-tree ssh-tree--empty">
        <span className="ssh-tree__loading">{t("ssh.tree.loading")}</span>
      </div>
    );
  }

  if (tree.error && !tree.loaded) {
    return (
      <div className="ssh-tree">
        <div className="ssh-tree__root-error">
          <span className="ssh-tree__root-error-text" title={tree.error}>
            {localizeError(tree.error)}
          </span>
          <button
            type="button"
            className="btn ssh-tree__retry-btn"
            onClick={() => void expandDir(profileId, tree.path)}
          >
            {t("ssh.tree.retry")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ssh-tree" ref={treeRef}>
      <input
        className="settings__input ssh-tree__jump"
        placeholder={t("ssh.tree.jump.placeholder")}
        value={jumpPath}
        onChange={(e) => setJumpPath(e.target.value)}
        onKeyDown={(e) => void handleJump(e)}
      />
      <div className="ssh-tree__list" role="tree">
        {tree.children.length === 0 ? (
          <div className="ssh-tree__empty">{t("ssh.tree.empty")}</div>
        ) : (
          <TreeNodes
            nodes={tree.children}
            depth={0}
            profileId={profileId}
            onToggle={toggleDir}
            onOpen={openFile}
            onContextMenu={handleContextMenu}
            expandDir={expandDir}
          />
        )}
      </div>

      {menu && (
        <div className="menu ssh-tree__menu" style={{ left: menu.x, top: menu.y }} role="menu">
          {menu.node.kind === "file" && (
            <button
              type="button"
              className="menu__item"
              onClick={() => {
                setMenu(null);
                void openFile(menu.node);
              }}
            >
              {t("ssh.tree.ctx.open")}
            </button>
          )}
          {menu.node.kind === "dir" && (
            <>
              <button
                type="button"
                className="menu__item"
                onClick={() => {
                  setMenu(null);
                  void ctxNewFile(menu.node.path);
                }}
              >
                {t("ssh.tree.ctx.newFile")}
              </button>
              <button
                type="button"
                className="menu__item"
                onClick={() => {
                  setMenu(null);
                  void ctxNewFolder(menu.node.path);
                }}
              >
                {t("ssh.tree.ctx.newFolder")}
              </button>
              <button
                type="button"
                className="menu__item"
                onClick={() => {
                  setMenu(null);
                  void ctxUpload(menu.node.path);
                }}
              >
                {t("ssh.tree.ctx.upload")}
              </button>
            </>
          )}
          {menu.node.kind === "file" && (
            <button
              type="button"
              className="menu__item"
              onClick={() => {
                setMenu(null);
                void ctxDownload(menu.node);
              }}
            >
              {t("ssh.tree.ctx.download")}
            </button>
          )}
          <div className="menu__sep" />
          <button
            type="button"
            className="menu__item"
            onClick={() => {
              setMenu(null);
              void ctxRename(menu.node);
            }}
          >
            {t("ssh.tree.ctx.rename")}
          </button>
          <button
            type="button"
            className="menu__item"
            onClick={() => {
              setMenu(null);
              void ctxDelete(menu.node);
            }}
          >
            {t("ssh.tree.ctx.delete")}
          </button>
          <div className="menu__sep" />
          <button
            type="button"
            className="menu__item"
            onClick={() => {
              setMenu(null);
              ctxCopyPath(menu.node);
            }}
          >
            {t("ssh.tree.ctx.copyPath")}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recursive tree node renderer
// ---------------------------------------------------------------------------

interface TreeNodesProps {
  nodes: SshTreeNode[];
  depth: number;
  profileId: string;
  onToggle(node: SshTreeNode): void;
  onOpen(node: SshTreeNode): void;
  onContextMenu(e: ReactMouseEvent, node: SshTreeNode): void;
  expandDir(profileId: string, path: string): Promise<void>;
}

function TreeNodes({
  nodes,
  depth,
  profileId,
  onToggle,
  onOpen,
  onContextMenu,
  expandDir,
}: TreeNodesProps) {
  const { t } = useI18n();

  if (nodes.length === 0) return null;

  return (
    <>
      {nodes.map((node) => (
        <div key={node.path}>
          <div
            className={`ssh-tree__row ${node.kind === "dir" ? "ssh-tree__row--dir" : ""}`}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            role="treeitem"
            aria-expanded={node.kind === "dir" ? (node.loaded ? true : false) : undefined}
            tabIndex={0}
            data-path={node.path}
            onDoubleClick={() => {
              if (node.kind === "dir") onToggle(node);
              else void onOpen(node);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (node.kind === "dir") onToggle(node);
                else void onOpen(node);
              } else if (e.key === "ArrowRight" && node.kind === "dir" && !node.loaded) {
                onToggle(node);
              } else if (e.key === "ArrowLeft" && node.kind === "dir" && node.loaded) {
                onToggle(node);
              }
            }}
            onContextMenu={(e) => onContextMenu(e, node)}
          >
            {node.kind === "dir" && (
              <span className="ssh-tree__chevron" aria-hidden="true">
                {node.loading ? "⏳" : node.loaded ? "▾" : "▸"}
              </span>
            )}
            {node.kind === "file" && (
              <span className="ssh-tree__icon" aria-hidden="true">
                📄
              </span>
            )}
            {node.kind === "dir" && !node.loading && node.loaded && (
              <span className="ssh-tree__icon" aria-hidden="true">
                📂
              </span>
            )}
            {node.kind === "dir" && !node.loading && !node.loaded && (
              <span className="ssh-tree__icon" aria-hidden="true">
                📁
              </span>
            )}
            <span className="ssh-tree__name">{node.name}</span>
          </div>

          {node.kind === "dir" && node.error && (
            <div className="ssh-tree__error" style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}>
              <span>{t("ssh.tree.error")}</span>
              <button
                type="button"
                className="btn ssh-tree__retry-btn"
                onClick={() => void expandDir(profileId, node.path)}
              >
                {t("ssh.tree.retry")}
              </button>
            </div>
          )}

          {node.kind === "dir" && node.loaded && node.children.length === 0 && !node.error && (
            <div className="ssh-tree__empty" style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}>
              {t("ssh.tree.empty")}
            </div>
          )}

          {node.kind === "dir" && node.loaded && node.children.length > 0 && (
            <TreeNodes
              nodes={node.children}
              depth={depth + 1}
              profileId={profileId}
              onToggle={onToggle}
              onOpen={onOpen}
              onContextMenu={onContextMenu}
              expandDir={expandDir}
            />
          )}

          {node.kind === "dir" && node.truncated && (
            <div
              className="ssh-tree__truncated"
              style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
            >
              {t("ssh.tree.truncated", { limit: 2000 })}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
