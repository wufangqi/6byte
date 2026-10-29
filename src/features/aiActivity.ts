import { useSyncExternalStore } from "react";

/** What the status bar shows while the AI panel is working. */
export type AiActivity = "idle" | "generating" | "review";

const listeners = new Set<() => void>();
let activity: AiActivity = "idle";

export function getAiActivity(): AiActivity {
  return activity;
}

export function setAiActivity(next: AiActivity): void {
  if (next === activity) return;
  activity = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAiActivity(): AiActivity {
  return useSyncExternalStore(subscribe, getAiActivity, () => "idle");
}
