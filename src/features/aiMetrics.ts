import { watchStorageKey } from "../lib/storageSync";
import type { AiUsage } from "../ipc/types";

/**
 * Local aggregate telemetry for the user's own settings screen.
 *
 * It deliberately has no prompt, completion text, model name, endpoint, file
 * path, API key, or per-request timestamp. The app never sends this record.
 */
export const AI_METRICS_KEY = "ainative.aiMetrics.v1";

export type AiMetricKind = "rewrite" | "completion" | "ask";
export type AiOfferKind = "rewrite" | "completion";

export interface RequestMetrics {
  started: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  firstTokenCount: number;
  firstTokenMs: number;
}

export interface OfferMetrics {
  shown: number;
  accepted: number;
}

export interface AiMetrics {
  version: 1;
  promptTokens: number;
  completionTokens: number;
  /** Number of successful replies that supplied a usage object. */
  usageReports: number;
  requests: Record<AiMetricKind, RequestMetrics>;
  offers: Record<AiOfferKind, OfferMetrics>;
}

const KINDS: AiMetricKind[] = ["rewrite", "completion", "ask"];
const OFFER_KINDS: AiOfferKind[] = ["rewrite", "completion"];
const MAX_COUNT = Number.MAX_SAFE_INTEGER;
const MAX_LATENCY_MS = 10 * 60 * 1_000;

const emptyRequest = (): RequestMetrics => ({
  started: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  firstTokenCount: 0,
  firstTokenMs: 0,
});

const emptyOffer = (): OfferMetrics => ({ shown: 0, accepted: 0 });

export function emptyAiMetrics(): AiMetrics {
  return {
    version: 1,
    promptTokens: 0,
    completionTokens: 0,
    usageReports: 0,
    requests: {
      rewrite: emptyRequest(),
      completion: emptyRequest(),
      ask: emptyRequest(),
    },
    offers: {
      rewrite: emptyOffer(),
      completion: emptyOffer(),
    },
  };
}

function count(value: unknown): number {
  const next = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(next) || next < 0) return 0;
  return Math.min(MAX_COUNT, Math.floor(next));
}

function request(value: unknown): RequestMetrics {
  const source = value && typeof value === "object" ? (value as Partial<RequestMetrics>) : {};
  return {
    started: count(source.started),
    succeeded: count(source.succeeded),
    failed: count(source.failed),
    cancelled: count(source.cancelled),
    firstTokenCount: count(source.firstTokenCount),
    firstTokenMs: count(source.firstTokenMs),
  };
}

function offer(value: unknown): OfferMetrics {
  const source = value && typeof value === "object" ? (value as Partial<OfferMetrics>) : {};
  const shown = count(source.shown);
  return { shown, accepted: Math.min(shown, count(source.accepted)) };
}

export function parseAiMetrics(raw: string | null | undefined): AiMetrics {
  if (!raw) return emptyAiMetrics();
  try {
    const value = JSON.parse(raw) as Partial<AiMetrics>;
    const requests: Partial<Record<AiMetricKind, unknown>> =
      value.requests && typeof value.requests === "object" ? value.requests : {};
    const offers: Partial<Record<AiOfferKind, unknown>> =
      value.offers && typeof value.offers === "object" ? value.offers : {};
    return {
      version: 1,
      promptTokens: count(value.promptTokens),
      completionTokens: count(value.completionTokens),
      usageReports: count(value.usageReports),
      requests: Object.fromEntries(KINDS.map((kind) => [kind, request(requests[kind])])) as Record<
        AiMetricKind,
        RequestMetrics
      >,
      offers: Object.fromEntries(OFFER_KINDS.map((kind) => [kind, offer(offers[kind])])) as Record<
        AiOfferKind,
        OfferMetrics
      >,
    };
  } catch {
    return emptyAiMetrics();
  }
}

export function loadAiMetrics(): AiMetrics {
  try {
    return parseAiMetrics(localStorage.getItem(AI_METRICS_KEY));
  } catch {
    return emptyAiMetrics();
  }
}

const listeners = new Set<() => void>();
let unwatchStorage: (() => void) | null = null;

function notify(): void {
  listeners.forEach((listener) => listener());
}

function watchMetricsStorage(): void {
  unwatchStorage ??= watchStorageKey(AI_METRICS_KEY, notify);
}

export function subscribeAiMetrics(listener: () => void): () => void {
  watchMetricsStorage();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function saveAiMetrics(metrics: AiMetrics): void {
  try {
    localStorage.setItem(AI_METRICS_KEY, JSON.stringify(metrics));
  } catch {
    // Metrics are optional; a locked/quota-limited store must never break AI.
  }
  notify();
}

export function resetAiMetrics(): void {
  saveAiMetrics(emptyAiMetrics());
}

function update(updateMetrics: (metrics: AiMetrics) => void): void {
  const metrics = loadAiMetrics();
  updateMetrics(metrics);
  saveAiMetrics(metrics);
}

function increment(value: number, amount = 1): number {
  return Math.min(MAX_COUNT, value + amount);
}

export function recordAiRequest(kind: AiMetricKind): void {
  update((metrics) => {
    metrics.requests[kind].started = increment(metrics.requests[kind].started);
  });
}

export function recordAiSuccess(kind: AiMetricKind, usage?: AiUsage): void {
  update((metrics) => {
    const request = metrics.requests[kind];
    request.succeeded = increment(request.succeeded);
    if (!usage) return;
    metrics.usageReports = increment(metrics.usageReports);
    metrics.promptTokens = increment(metrics.promptTokens, count(usage.promptTokens));
    metrics.completionTokens = increment(metrics.completionTokens, count(usage.completionTokens));
  });
}

export function recordAiFailure(kind: AiMetricKind): void {
  update((metrics) => {
    metrics.requests[kind].failed = increment(metrics.requests[kind].failed);
  });
}

export function recordAiCancellation(kind: AiMetricKind): void {
  update((metrics) => {
    metrics.requests[kind].cancelled = increment(metrics.requests[kind].cancelled);
  });
}

export function recordAiFirstToken(kind: AiMetricKind, elapsedMs: number): void {
  const elapsed = Math.max(0, Math.min(MAX_LATENCY_MS, Math.round(elapsedMs)));
  update((metrics) => {
    const request = metrics.requests[kind];
    request.firstTokenCount = increment(request.firstTokenCount);
    request.firstTokenMs = increment(request.firstTokenMs, elapsed);
  });
}

export function recordAiOffer(kind: AiOfferKind): void {
  update((metrics) => {
    metrics.offers[kind].shown = increment(metrics.offers[kind].shown);
  });
}

export function recordAiAcceptance(kind: AiOfferKind): void {
  update((metrics) => {
    const offer = metrics.offers[kind];
    // A programmatic accept without an offer is not meaningful telemetry.
    if (offer.accepted >= offer.shown) return;
    offer.accepted = increment(offer.accepted);
  });
}

export function failureRate(metrics: RequestMetrics): number | null {
  const completed = metrics.succeeded + metrics.failed;
  return completed === 0 ? null : metrics.failed / completed;
}

export function acceptanceRate(metrics: OfferMetrics): number | null {
  return metrics.shown === 0 ? null : metrics.accepted / metrics.shown;
}

export function averageFirstTokenMs(metrics: RequestMetrics): number | null {
  return metrics.firstTokenCount === 0
    ? null
    : Math.round(metrics.firstTokenMs / metrics.firstTokenCount);
}
