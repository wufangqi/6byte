import { onAiDone, onAiError, onAiToken } from "./api";
import type { AiDoneEvent, AiErrorEvent, AiTokenEvent } from "./types";

/**
 * One listener for model events. Each stream id has one owner.
 * Events that arrive before that owner calls `bind` wait on the id,
 * and are never handed to a different request.
 */

export interface AiStreamListener {
  token(event: AiTokenEvent): void;
  done(event: AiDoneEvent): void;
  error(event: AiErrorEvent): void;
}

export interface AiStreamClaim {
  bind(streamId: string): void;
  release(): void;
}

type StreamEvent =
  | { type: "token"; event: AiTokenEvent }
  | { type: "done"; event: AiDoneEvent }
  | { type: "error"; event: AiErrorEvent };

const owners = new Map<string, AiStreamListener>();
const pending = new Map<string, StreamEvent[]>();
const retired = new Set<string>();

const MAX_PENDING_IDS = 32;
const MAX_EVENTS = 64;
const MAX_RETIRED = 128;

let busStarted = false;

function streamIdOf(event: StreamEvent): string {
  return event.event.streamId;
}

function dispatch(listener: AiStreamListener, event: StreamEvent): void {
  if (event.type === "token") listener.token(event.event);
  else if (event.type === "done") listener.done(event.event);
  else listener.error(event.event);
}

function rememberRetired(streamId: string): void {
  retired.add(streamId);
  if (retired.size <= MAX_RETIRED) return;
  const oldest = retired.values().next().value;
  if (oldest !== undefined) retired.delete(oldest);
}

/** Drop a stream that will never be claimed, including anything already buffered. */
export function abandonAiStream(streamId: string): void {
  owners.delete(streamId);
  pending.delete(streamId);
  rememberRetired(streamId);
}

export function deliverAiStreamEvent(event: StreamEvent): void {
  const id = streamIdOf(event);
  if (retired.has(id)) return;
  const owner = owners.get(id);
  if (owner) {
    dispatch(owner, event);
    return;
  }
  const queue = pending.get(id) ?? [];
  queue.push(event);
  if (queue.length > MAX_EVENTS) queue.shift();
  pending.set(id, queue);
  while (pending.size > MAX_PENDING_IDS) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
}

export function claimAiStream(listener: AiStreamListener): AiStreamClaim {
  void ensureBus();
  let current: string | null = null;
  return {
    bind(streamId: string) {
      if (current && current !== streamId) abandonAiStream(current);
      current = streamId;
      retired.delete(streamId);
      owners.set(streamId, listener);
      const queued = pending.get(streamId);
      pending.delete(streamId);
      if (!queued) return;
      for (const event of queued) dispatch(listener, event);
    },
    release() {
      if (!current) return;
      const id = current;
      current = null;
      if (owners.get(id) === listener) abandonAiStream(id);
    },
  };
}

async function ensureBus(): Promise<void> {
  if (busStarted) return;
  busStarted = true;
  await Promise.all([
    onAiToken((event) => deliverAiStreamEvent({ type: "token", event })),
    onAiDone((event) => deliverAiStreamEvent({ type: "done", event })),
    onAiError((event) => deliverAiStreamEvent({ type: "error", event })),
  ]);
}

/** Test hook. Does not unsubscribe the Tauri listeners. */
export function resetAiStreamBusForTests(): void {
  owners.clear();
  pending.clear();
  retired.clear();
}
