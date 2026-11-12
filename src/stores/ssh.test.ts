/**
 * The tree must load on a fresh session: `expandDir` is what creates the root
 * node, so a regression here leaves the panel spinning forever (the original
 * bug). These tests pin that behaviour and the root-path prefix matching.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const listDir = vi.fn();

vi.mock("../ipc/ssh", () => ({
  sshListDir: (...args: unknown[]) => listDir(...args),
  sshProfileList: vi.fn(async () => []),
  sshConnect: vi.fn(),
  sshDisconnect: vi.fn(async () => {}),
  sshSessions: vi.fn(async () => []),
  sshForwardList: vi.fn(async () => []),
  sshForwardAdd: vi.fn(),
  sshForwardStop: vi.fn(),
  sshProfileSave: vi.fn(),
  sshProfileDelete: vi.fn(),
}));

import type { ForwardInfo } from "../ipc/ssh";
import { NO_FORWARDS, forwardsOf, useSshStore } from "./ssh";

const entry = (name: string, kind: "file" | "dir", path: string) => ({
  name,
  path,
  kind,
  size: 0,
  mtimeMs: 0,
});

describe("SSH tree loading", () => {
  beforeEach(() => {
    listDir.mockReset();
    useSshStore.setState({
      profiles: [],
      sessions: [],
      trees: new Map(),
      forwards: new Map(),
      transfers: [],
    });
  });

  it("creates the root node on the first expand and attaches the listing", async () => {
    listDir.mockResolvedValue({
      entries: [entry("src", "dir", "/home/me/src"), entry("a.txt", "file", "/home/me/a.txt")],
      truncated: false,
      limit: 2000,
    });

    await useSshStore.getState().expandDir("p1", "/home/me");

    expect(listDir).toHaveBeenCalledWith("p1", "/home/me");
    const tree = useSshStore.getState().trees.get("p1");
    expect(tree).toBeDefined();
    expect(tree?.path).toBe("/home/me");
    expect(tree?.loaded).toBe(true);
    expect(tree?.loading).toBe(false);
    expect(tree?.children.map((c) => c.name)).toEqual(["src", "a.txt"]);
  });

  it("keeps the error on the root node when the first listing fails", async () => {
    listDir.mockRejectedValue(new Error("读取失败：denied"));

    await useSshStore.getState().expandDir("p1", "/root");

    const tree = useSshStore.getState().trees.get("p1");
    expect(tree?.loading).toBe(false);
    expect(tree?.error).toBe("读取失败：denied");
    expect(tree?.children).toEqual([]);
  });

  it("expands a directory directly under the filesystem root", async () => {
    listDir.mockResolvedValueOnce({
      entries: [entry("etc", "dir", "/etc")],
      truncated: false,
      limit: 2000,
    });
    await useSshStore.getState().expandDir("p1", "/");

    listDir.mockResolvedValueOnce({
      entries: [entry("hosts", "file", "/etc/hosts")],
      truncated: false,
      limit: 2000,
    });
    await useSshStore.getState().expandDir("p1", "/etc");

    const tree = useSshStore.getState().trees.get("p1");
    const etc = tree?.children.find((c) => c.name === "etc");
    expect(etc?.loaded).toBe(true);
    expect(etc?.children.map((c) => c.name)).toEqual(["hosts"]);
  });

  it("drops the cached tree on disconnect so a reconnect refetches", async () => {
    listDir.mockResolvedValue({ entries: [], truncated: false, limit: 2000 });
    await useSshStore.getState().expandDir("p1", "/home/me");
    expect(useSshStore.getState().trees.has("p1")).toBe(true);

    await useSshStore.getState().disconnect("p1");
    expect(useSshStore.getState().trees.has("p1")).toBe(false);
  });
});

describe("forward selector stability", () => {
  // A selector returning a fresh array on every read makes React loop until it
  // throws "Maximum update depth exceeded", which blanks the window (the ports
  // tab used to do exactly that).
  it("returns one shared empty array when the profile has no forwards", () => {
    const map = new Map<string, ForwardInfo[]>();
    expect(forwardsOf(map, "a")).toBe(NO_FORWARDS);
    expect(forwardsOf(map, "b")).toBe(NO_FORWARDS);
    expect(forwardsOf(map, "a")).toBe(forwardsOf(map, "b"));
  });

  it("returns the stored list when one exists", () => {
    const list: ForwardInfo[] = [];
    const map = new Map([["a", list]]);
    expect(forwardsOf(map, "a")).toBe(list);
  });
});
