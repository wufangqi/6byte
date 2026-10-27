// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_METRICS_KEY,
  acceptanceRate,
  averageFirstTokenMs,
  emptyAiMetrics,
  failureRate,
  loadAiMetrics,
  parseAiMetrics,
  recordAiAcceptance,
  recordAiCancellation,
  recordAiFailure,
  recordAiFirstToken,
  recordAiOffer,
  recordAiRequest,
  recordAiSuccess,
  resetAiMetrics,
  subscribeAiMetrics,
} from "./aiMetrics";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("AI metrics", () => {
  it("starts empty and ignores malformed persisted data", () => {
    expect(loadAiMetrics()).toEqual(emptyAiMetrics());
    expect(parseAiMetrics("{bad json")).toEqual(emptyAiMetrics());
    expect(parseAiMetrics(null)).toEqual(emptyAiMetrics());
  });

  it("keeps only aggregate counts from completed requests", () => {
    recordAiRequest("rewrite");
    recordAiFirstToken("rewrite", 328.6);
    recordAiSuccess("rewrite", { promptTokens: 120, completionTokens: 28 });
    recordAiRequest("ask");
    recordAiFailure("ask");
    recordAiRequest("completion");
    recordAiCancellation("completion");

    expect(loadAiMetrics()).toEqual({
      version: 1,
      promptTokens: 120,
      completionTokens: 28,
      usageReports: 1,
      requests: {
        rewrite: {
          started: 1,
          succeeded: 1,
          failed: 0,
          cancelled: 0,
          firstTokenCount: 1,
          firstTokenMs: 329,
        },
        completion: {
          started: 1,
          succeeded: 0,
          failed: 0,
          cancelled: 1,
          firstTokenCount: 0,
          firstTokenMs: 0,
        },
        ask: {
          started: 1,
          succeeded: 0,
          failed: 1,
          cancelled: 0,
          firstTokenCount: 0,
          firstTokenMs: 0,
        },
      },
      offers: {
        rewrite: { shown: 0, accepted: 0 },
        completion: { shown: 0, accepted: 0 },
      },
    });
    const raw = localStorage.getItem(AI_METRICS_KEY) ?? "";
    expect(raw).not.toContain("model");
    expect(raw).not.toContain("prompt text");
    expect(raw).not.toContain("apiKey");
  });

  it("records offers and never lets acceptance exceed shown", () => {
    recordAiAcceptance("rewrite");
    recordAiOffer("rewrite");
    recordAiOffer("rewrite");
    recordAiAcceptance("rewrite");
    recordAiAcceptance("rewrite");
    recordAiAcceptance("rewrite");

    const offer = loadAiMetrics().offers.rewrite;
    expect(offer).toEqual({ shown: 2, accepted: 2 });
    expect(acceptanceRate(offer)).toBe(1);
    expect(acceptanceRate({ shown: 0, accepted: 0 })).toBeNull();
  });

  it("calculates failure and first-token summaries without cancellations", () => {
    expect(
      failureRate({
        started: 3,
        succeeded: 2,
        failed: 1,
        cancelled: 9,
        firstTokenCount: 2,
        firstTokenMs: 505,
      })
    ).toBe(1 / 3);
    expect(
      averageFirstTokenMs({
        started: 3,
        succeeded: 2,
        failed: 1,
        cancelled: 0,
        firstTokenCount: 2,
        firstTokenMs: 505,
      })
    ).toBe(253);
    expect(failureRate(emptyAiMetrics().requests.ask)).toBeNull();
    expect(averageFirstTokenMs(emptyAiMetrics().requests.ask)).toBeNull();
  });

  it("sanitises damaged data and ensures accepted does not exceed shown", () => {
    expect(
      parseAiMetrics(
        JSON.stringify({
          promptTokens: -2,
          completionTokens: "3.8",
          usageReports: Infinity,
          requests: {
            rewrite: { started: 2.9, failed: -5, firstTokenMs: "not a number" },
          },
          offers: { rewrite: { shown: 1, accepted: 9 } },
        })
      )
    ).toMatchObject({
      promptTokens: 0,
      completionTokens: 3,
      usageReports: 0,
      requests: { rewrite: { started: 2, failed: 0, firstTokenMs: 0 } },
      offers: { rewrite: { shown: 1, accepted: 1 } },
    });
  });

  it("notifies local subscribers and can reset the aggregate", () => {
    const listener = vi.fn();
    const stop = subscribeAiMetrics(listener);
    recordAiRequest("rewrite");
    expect(listener).toHaveBeenCalledTimes(1);
    resetAiMetrics();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(loadAiMetrics()).toEqual(emptyAiMetrics());
    stop();
  });
});
