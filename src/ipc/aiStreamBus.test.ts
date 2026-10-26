import { beforeEach, describe, expect, it } from "vitest";
import {
  abandonAiStream,
  claimAiStream,
  deliverAiStreamEvent,
  resetAiStreamBusForTests,
  type AiStreamListener,
} from "./aiStreamBus";

function listener(): AiStreamListener & { tokens: string[]; finished: string[] } {
  const tokens: string[] = [];
  const finished: string[] = [];
  return {
    tokens,
    finished,
    token: (event) => tokens.push(`${event.streamId}:${event.delta}`),
    done: (event) => {
      finished.push(event.streamId);
    },
    error: () => {},
  };
}

describe("ai stream bus", () => {
  beforeEach(() => {
    resetAiStreamBusForTests();
  });

  it("gives a stream only to the claim that binds it, including events that arrived first", () => {
    const rewrite = listener();
    const completion = listener();
    const rewriteClaim = claimAiStream(rewrite);
    const completionClaim = claimAiStream(completion);

    deliverAiStreamEvent({
      type: "token",
      event: { streamId: "rewrite-1", delta: "甲", kind: "content" },
    });
    deliverAiStreamEvent({
      type: "token",
      event: { streamId: "complete-1", delta: "乙", kind: "content" },
    });

    rewriteClaim.bind("rewrite-1");
    completionClaim.bind("complete-1");

    expect(rewrite.tokens).toEqual(["rewrite-1:甲"]);
    expect(completion.tokens).toEqual(["complete-1:乙"]);
  });

  it("drops events after the claim releases that stream", () => {
    const rewrite = listener();
    const claim = claimAiStream(rewrite);
    claim.bind("rewrite-1");
    claim.release();
    deliverAiStreamEvent({
      type: "token",
      event: { streamId: "rewrite-1", delta: "晚", kind: "content" },
    });
    deliverAiStreamEvent({ type: "done", event: { streamId: "rewrite-1" } });
    expect(rewrite.tokens).toEqual([]);
    expect(rewrite.finished).toEqual([]);
  });

  it("abandons an id that will never be bound", () => {
    abandonAiStream("gone");
    deliverAiStreamEvent({
      type: "token",
      event: { streamId: "gone", delta: "x", kind: "content" },
    });
    const next = listener();
    claimAiStream(next).bind("gone");
    expect(next.tokens).toEqual([]);
  });
});
