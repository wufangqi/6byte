/**
 * Zustand store for SSH remote functionality.
 *
 * Holds profiles, sessions, per-session tree caches, port forwards, and
 * transfer progress. Actions call the typed IPC wrappers in `ipc/ssh.ts`.
 */
import { create } from "zustand";
import type {
  ForwardInfo,
  ForwardSpec,
  SshProfile,
  SshProfileInfo,
  SshSessionInfo,
  SshTransferEvent,
} from "../ipc/ssh";

// ---------------------------------------------------------------------------
// Tree node (mirrors RemoteEntry but with lazy children)
// ---------------------------------------------------------------------------

export interface SshTreeNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  size: number;
  mtimeMs: number;
  /** Children loaded so far (only for dirs). */
  children: SshTreeNode[];
  /** Whether children have been fetched at least once. */
  loaded: boolean;
  /** Whether a fetch is currently in flight. */
  loading: boolean;
  /** Error message if the last fetch failed. */
  error: string | null;
  /** True when the backend truncated the listing. */
  truncated: boolean;
}

function nodeFromEntry(entry: {
  name: string;
  path: string;
  kind: "file" | "dir";
  size: number;
  mtimeMs: number;
}): SshTreeNode {
  return {
    name: entry.name,
    path: entry.path,
    kind: entry.kind,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    children: [],
    loaded: false,
    loading: false,
    error: null,
    truncated: false,
  };
}

/**
 * Root node for a profile's tree. Created lazily the first time `expandDir`
 * runs for that profile: a fresh session has no cached tree, and without a node
 * there is nothing for the listing to attach to.
 */
function rootNode(dirPath: string): SshTreeNode {
  const trimmed = dirPath.replace(/\/+$/, "");
  const name = trimmed === "" ? "/" : (trimmed.split("/").pop() ?? dirPath);
  return {
    name,
    path: dirPath,
    kind: "dir",
    size: 0,
    mtimeMs: 0,
    children: [],
    loaded: false,
    loading: true,
    error: null,
    truncated: false,
  };
}

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

interface SshState {
  profiles: SshProfileInfo[];
  sessions: SshSessionInfo[];
  /** Per-profile tree root cache. Key = profileId. */
  trees: Map<string, SshTreeNode>;
  forwards: Map<string, ForwardInfo[]>;
  transfers: SshTransferEvent[];

  // Profile actions
  refreshProfiles(): Promise<void>;
  saveProfile(profile: SshProfile, password?: string, passphrase?: string): Promise<SshProfileInfo>;
  deleteProfile(id: string): Promise<void>;

  // Session actions
  connect(profileId: string, password?: string, passphrase?: string): Promise<void>;
  disconnect(profileId: string): Promise<void>;
  refreshSessions(): Promise<void>;
  updateSession(info: SshSessionInfo): void;

  // Tree actions
  expandDir(profileId: string, dirPath: string): Promise<void>;
  invalidateTree(profileId: string): void;
  invalidatePath(profileId: string, dirPath: string): void;

  // Forward actions
  addForward(profileId: string, spec: ForwardSpec): Promise<ForwardInfo>;
  stopForward(profileId: string, forwardId: string): Promise<void>;
  refreshForwards(profileId: string): Promise<void>;
  updateForwards(profileId: string, forwards: ForwardInfo[]): void;

  // Transfer actions
  updateTransfer(event: SshTransferEvent): void;
  clearTransfer(transferId: string): void;
  clearFinishedTransfers(): void;
}

// ---------------------------------------------------------------------------
// Helpers to update nested tree nodes immutably
// ---------------------------------------------------------------------------

function updateNodeAtPath(
  nodes: SshTreeNode[],
  targetPath: string,
  updater: (node: SshTreeNode) => SshTreeNode
): SshTreeNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) return updater(node);
    const childPrefix = node.path.endsWith("/") ? node.path : `${node.path}/`;
    if (node.kind === "dir" && targetPath.startsWith(childPrefix)) {
      return { ...node, children: updateNodeAtPath(node.children, targetPath, updater) };
    }
    return node;
  });
}

function setRootChildren(
  roots: SshTreeNode[],
  targetPath: string,
  children: SshTreeNode[],
  truncated: boolean
): SshTreeNode[] {
  return updateNodeAtPath(roots, targetPath, (node) => ({
    ...node,
    children,
    loaded: true,
    loading: false,
    error: null,
    truncated,
  }));
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSshStore = create<SshState>((set, get) => ({
  profiles: [],
  sessions: [],
  trees: new Map(),
  forwards: new Map(),
  transfers: [],

  async refreshProfiles() {
    const { sshProfileList } = await import("../ipc/ssh");
    try {
      const profiles = await sshProfileList();
      set({ profiles });
    } catch {
      /* keep stale data on error */
    }
  },

  async saveProfile(profile, password, passphrase) {
    const { sshProfileSave } = await import("../ipc/ssh");
    const info = await sshProfileSave({ profile, password, passphrase });
    set((state) => {
      const exists = state.profiles.some((p) => p.id === info.id);
      const profiles = exists
        ? state.profiles.map((p) => (p.id === info.id ? info : p))
        : [...state.profiles, info];
      return { profiles };
    });
    return info;
  },

  async deleteProfile(id) {
    const { sshProfileDelete } = await import("../ipc/ssh");
    await sshProfileDelete(id);
    set((state) => ({
      profiles: state.profiles.filter((p) => p.id !== id),
      sessions: state.sessions.filter((s) => s.profileId !== id),
      trees: new Map([...state.trees].filter(([key]) => key !== id)),
      forwards: new Map([...state.forwards].filter(([key]) => key !== id)),
    }));
  },

  async connect(profileId, password, passphrase) {
    const { sshConnect } = await import("../ipc/ssh");
    const info = await sshConnect({ profileId, password, passphrase });
    get().updateSession(info);
  },

  async disconnect(profileId) {
    const { sshDisconnect } = await import("../ipc/ssh");
    await sshDisconnect(profileId);
    set((state) => {
      const trees = new Map(state.trees);
      trees.delete(profileId);
      return {
        sessions: state.sessions.map((s) =>
          s.profileId === profileId
            ? { ...s, state: "disconnected" as const, home: "", message: "" }
            : s
        ),
        trees,
      };
    });
  },

  async refreshSessions() {
    const { sshSessions } = await import("../ipc/ssh");
    try {
      const sessions = await sshSessions();
      set({ sessions });
    } catch {
      /* keep stale data */
    }
  },

  updateSession(info) {
    set((state) => {
      const exists = state.sessions.some((s) => s.profileId === info.profileId);
      const sessions = exists
        ? state.sessions.map((s) => (s.profileId === info.profileId ? info : s))
        : [...state.sessions, info];
      return { sessions };
    });
  },

  async expandDir(profileId, dirPath) {
    const { sshListDir } = await import("../ipc/ssh");

    // Mark loading; on the first call for a profile this is also what creates
    // the root node the listing attaches to.
    set((state) => {
      const tree = state.trees.get(profileId);
      if (!tree) {
        return { trees: new Map(state.trees).set(profileId, rootNode(dirPath)) };
      }
      const roots = updateNodeAtPath([tree], dirPath, (n) => ({
        ...n,
        loading: true,
        error: null,
      }));
      return { trees: new Map(state.trees).set(profileId, roots[0]) };
    });

    try {
      const result = await sshListDir(profileId, dirPath);
      const children = result.entries.map(nodeFromEntry);
      set((state) => {
        const tree = state.trees.get(profileId);
        if (!tree) return state;
        const roots = setRootChildren([tree], dirPath, children, result.truncated);
        return { trees: new Map(state.trees).set(profileId, roots[0]) };
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set((state) => {
        const tree = state.trees.get(profileId);
        if (!tree) return state;
        const roots = updateNodeAtPath([tree], dirPath, (n) => ({
          ...n,
          loading: false,
          error: message,
        }));
        return { trees: new Map(state.trees).set(profileId, roots[0]) };
      });
    }
  },

  invalidateTree(profileId) {
    set((state) => {
      const next = new Map(state.trees);
      next.delete(profileId);
      return { trees: next };
    });
  },

  invalidatePath(profileId, dirPath) {
    set((state) => {
      const tree = state.trees.get(profileId);
      if (!tree) return state;
      const roots = updateNodeAtPath([tree], dirPath, (n) => ({
        ...n,
        loaded: false,
        children: [],
        error: null,
      }));
      return { trees: new Map(state.trees).set(profileId, roots[0]) };
    });
  },

  async addForward(profileId, spec) {
    const { sshForwardAdd } = await import("../ipc/ssh");
    const info = await sshForwardAdd(profileId, spec);
    set((state) => {
      const list = [...(state.forwards.get(profileId) ?? []), info];
      return { forwards: new Map(state.forwards).set(profileId, list) };
    });
    return info;
  },

  async stopForward(profileId, forwardId) {
    const { sshForwardStop } = await import("../ipc/ssh");
    await sshForwardStop(profileId, forwardId);
    set((state) => {
      const list = (state.forwards.get(profileId) ?? []).filter((f) => f.id !== forwardId);
      return { forwards: new Map(state.forwards).set(profileId, list) };
    });
  },

  async refreshForwards(profileId) {
    const { sshForwardList } = await import("../ipc/ssh");
    try {
      const forwards = await sshForwardList(profileId);
      set((state) => ({
        forwards: new Map(state.forwards).set(profileId, forwards),
      }));
    } catch {
      /* keep stale */
    }
  },

  updateForwards(profileId, forwards) {
    set((state) => ({
      forwards: new Map(state.forwards).set(profileId, forwards),
    }));
  },

  updateTransfer(event) {
    set((state) => {
      const idx = state.transfers.findIndex((t) => t.transferId === event.transferId);
      const transfers = [...state.transfers];
      if (idx >= 0) transfers[idx] = event;
      else transfers.push(event);
      return { transfers };
    });
  },

  clearTransfer(transferId) {
    set((state) => ({
      transfers: state.transfers.filter((t) => t.transferId !== transferId),
    }));
  },

  clearFinishedTransfers() {
    set((state) => ({
      transfers: state.transfers.filter((t) => !t.done),
    }));
  },
}));
