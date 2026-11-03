import { loadDenylistText } from "./agentAccess";
import {
  isTauri,
  setLocalAgentEditor,
  setLocalAgentGate,
  startLocalAgent,
  stopLocalAgent,
  type LocalAgentInfo,
} from "../ipc/api";

export type { LocalAgentInfo };
import { useFileTree } from "../stores/fileTree";

export const LOCAL_AGENT_KEY = "ainative.localAgent";
/** Keep the published buffer under the Rust cap. */
export const EDITOR_TEXT_CAP = 400_000;
export const SELECTION_CAP = 32_000;

const listeners = new Set<() => void>();

export function localAgentPreferred(): boolean {
  try {
    return localStorage.getItem(LOCAL_AGENT_KEY) === "1";
  } catch {
    return false;
  }
}

export function subscribeLocalAgent(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function remember(enabled: boolean): void {
  const next = enabled ? "1" : "0";
  if (localStorage.getItem(LOCAL_AGENT_KEY) === next) return;
  localStorage.setItem(LOCAL_AGENT_KEY, next);
  for (const listener of listeners) listener();
}

export function currentGate(): { root: string; denylist: string } {
  return {
    root: useFileTree.getState().rootPath ?? "",
    denylist: loadDenylistText(),
  };
}

export async function enableLocalAgent(): Promise<LocalAgentInfo> {
  const gate = currentGate();
  const info = await startLocalAgent(gate.root, gate.denylist);
  remember(true);
  return info;
}

export async function disableLocalAgent(): Promise<void> {
  if (isTauri) await stopLocalAgent();
  remember(false);
}

export async function syncLocalAgentGate(): Promise<void> {
  if (!isTauri || !localAgentPreferred()) return;
  const gate = currentGate();
  await setLocalAgentGate(gate.root, gate.denylist);
}

/** Drop an oversized document body before it crosses IPC. The selection stays. */
export function fitEditorText(text: string): { text: string; truncated: boolean } {
  if (text.length <= EDITOR_TEXT_CAP) return { text, truncated: false };
  return { text: "", truncated: true };
}

export function fitSelection(text: string): string {
  return text.length <= SELECTION_CAP ? text : text.slice(0, SELECTION_CAP);
}

/** Cursor-style MCP config. The command is the program next to 6byte, not the token. */
export function mcpConfigText(command: string): string {
  return JSON.stringify({ mcpServers: { "6byte": { command } } }, null, 2);
}

export async function publishEditor(snapshot: {
  path: string;
  name: string;
  revision: number;
  text: string;
  selectionFrom: number;
  selectionTo: number;
  selectionText: string;
}): Promise<void> {
  if (!isTauri || !localAgentPreferred()) return;
  const body = fitEditorText(snapshot.text);
  await setLocalAgentEditor({
    ...snapshot,
    text: body.text,
    selectionText: fitSelection(snapshot.selectionText),
  });
}
