/**
 * Typed IPC wrappers for SSH remote functionality.
 *
 * This is the **only** new file that imports `@tauri-apps/*`. Every other SSH
 * module goes through these functions so the rest of the app stays decoupled
 * from Tauri internals.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "./api";
import { t } from "../i18n/locale";
import type { FileMeta, OpenedFile, RenameResult, WriteResult } from "./types";

// ---------------------------------------------------------------------------
// Types (mirrors docs/ssh-remote-design.md §2 exactly)
// ---------------------------------------------------------------------------

export type SshAuth = "password" | "key" | "agent";

export interface SshProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  keyPath: string;
  rememberSecret: boolean;
}

export interface SshProfileInfo extends SshProfile {
  hasPassword: boolean;
  hasPassphrase: boolean;
}

export type SshSessionState = "connecting" | "connected" | "disconnected" | "error";

export interface SshSessionInfo {
  profileId: string;
  state: SshSessionState;
  host: string;
  port: number;
  username: string;
  home: string;
  message: string;
}

export interface RemoteEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
  size: number;
  mtimeMs: number;
}

export interface RemoteDirList {
  entries: RemoteEntry[];
  truncated: boolean;
  limit: number;
}

export interface RemoteStat {
  size: number;
  mtimeMs: number;
  kind: "file" | "dir";
}

export type ForwardSpec =
  | { kind: "local"; localPort: number; remoteHost: string; remotePort: number }
  | { kind: "remote"; remotePort: number; localHost: string; localPort: number }
  | { kind: "dynamic"; localPort: number };

export interface ForwardInfo {
  id: string;
  spec: ForwardSpec;
  status: "active" | "stopped" | "error";
  boundPort: number;
  connections: number;
  totalConnections: number;
  upBytes: number;
  downBytes: number;
  error: string;
}

export interface SshTransferEvent {
  transferId: string;
  profileId: string;
  kind: "upload" | "download";
  name: string;
  transferred: number;
  total: number;
  done: boolean;
  error: string;
}

export interface SshHostKeyMismatchEvent {
  profileId: string;
  host: string;
  port: number;
  expected: string;
  actual: string;
}

export interface SshForwardUpdateEvent {
  profileId: string;
  forwards: ForwardInfo[];
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

function requireTauri(): void {
  if (!isTauri) {
    throw new Error(t("ipc.requireTauri", { action: t("ipc.ssh") }));
  }
}

// ---------------------------------------------------------------------------
// Commands (§3)
// ---------------------------------------------------------------------------

export async function sshProfileList(): Promise<SshProfileInfo[]> {
  requireTauri();
  return invoke<SshProfileInfo[]>("ssh_profile_list");
}

export async function sshProfileSave(params: {
  profile: SshProfile;
  password?: string;
  passphrase?: string;
}): Promise<SshProfileInfo> {
  requireTauri();
  return invoke<SshProfileInfo>("ssh_profile_save", params);
}

export async function sshProfileDelete(id: string): Promise<void> {
  requireTauri();
  return invoke<void>("ssh_profile_delete", { id });
}

export async function sshConnect(params: {
  profileId: string;
  password?: string;
  passphrase?: string;
}): Promise<SshSessionInfo> {
  requireTauri();
  return invoke<SshSessionInfo>("ssh_connect", params);
}

export async function sshDisconnect(profileId: string): Promise<void> {
  requireTauri();
  return invoke<void>("ssh_disconnect", { profileId });
}

export async function sshSessions(): Promise<SshSessionInfo[]> {
  requireTauri();
  return invoke<SshSessionInfo[]>("ssh_sessions");
}

export async function sshHome(profileId: string): Promise<string> {
  requireTauri();
  return invoke<string>("ssh_home", { profileId });
}

export async function sshListDir(profileId: string, path: string): Promise<RemoteDirList> {
  requireTauri();
  return invoke<RemoteDirList>("ssh_list_dir", { profileId, path });
}

export async function sshStat(profileId: string, path: string): Promise<RemoteStat> {
  requireTauri();
  return invoke<RemoteStat>("ssh_stat", { profileId, path });
}

export async function sshReadFile(profileId: string, path: string): Promise<OpenedFile> {
  requireTauri();
  return invoke<OpenedFile>("ssh_read_file", { profileId, path });
}

export async function sshWriteFile(params: {
  profileId: string;
  path: string;
  content: string;
  meta: FileMeta;
  allowLossy: boolean;
}): Promise<WriteResult> {
  requireTauri();
  return invoke<WriteResult>("ssh_write_file", params);
}

export async function sshMkdir(profileId: string, path: string): Promise<void> {
  requireTauri();
  return invoke<void>("ssh_mkdir", { profileId, path });
}

export async function sshCreateFile(profileId: string, path: string): Promise<void> {
  requireTauri();
  return invoke<void>("ssh_create_file", { profileId, path });
}

export async function sshRename(
  profileId: string,
  path: string,
  name: string
): Promise<RenameResult> {
  requireTauri();
  return invoke<RenameResult>("ssh_rename", { profileId, path, name });
}

export async function sshDelete(profileId: string, path: string): Promise<void> {
  requireTauri();
  return invoke<void>("ssh_delete", { profileId, path });
}

export async function sshUpload(
  profileId: string,
  localPath: string,
  remoteDir: string
): Promise<{ transferId: string }> {
  requireTauri();
  return invoke<{ transferId: string }>("ssh_upload", { profileId, localPath, remoteDir });
}

export async function sshDownload(
  profileId: string,
  path: string,
  localPath: string
): Promise<{ transferId: string }> {
  requireTauri();
  return invoke<{ transferId: string }>("ssh_download", { profileId, path, localPath });
}

export async function sshForwardAdd(profileId: string, spec: ForwardSpec): Promise<ForwardInfo> {
  requireTauri();
  return invoke<ForwardInfo>("ssh_forward_add", { profileId, spec });
}

export async function sshForwardStop(profileId: string, forwardId: string): Promise<void> {
  requireTauri();
  return invoke<void>("ssh_forward_stop", { profileId, forwardId });
}

export async function sshForwardList(profileId: string): Promise<ForwardInfo[]> {
  requireTauri();
  return invoke<ForwardInfo[]>("ssh_forward_list", { profileId });
}

export async function sshForgetHost(host: string, port: number): Promise<void> {
  requireTauri();
  return invoke<void>("ssh_forget_host", { host, port });
}

// ---------------------------------------------------------------------------
// Events (§4)
// ---------------------------------------------------------------------------

/** Subscribe to SSH session state changes. Returns an unlisten function. */
export async function onSshSession(handler: (event: SshSessionInfo) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  return listen<SshSessionInfo>("ssh-session", (event) => handler(event.payload));
}

/** Subscribe to port-forward lifecycle / stats updates. */
export async function onSshForwardUpdate(
  handler: (event: SshForwardUpdateEvent) => void
): Promise<() => void> {
  if (!isTauri) return () => {};
  return listen<SshForwardUpdateEvent>("ssh-forward-update", (event) => handler(event.payload));
}

/** Subscribe to upload / download progress. */
export async function onSshTransfer(
  handler: (event: SshTransferEvent) => void
): Promise<() => void> {
  if (!isTauri) return () => {};
  return listen<SshTransferEvent>("ssh-transfer", (event) => handler(event.payload));
}

/** Subscribe to host-key mismatch alerts (TOFU). */
export async function onSshHostKeyMismatch(
  handler: (event: SshHostKeyMismatchEvent) => void
): Promise<() => void> {
  if (!isTauri) return () => {};
  return listen<SshHostKeyMismatchEvent>("ssh-hostkey-mismatch", (event) => handler(event.payload));
}
