import { describe, expect, it } from "vitest";
import {
  acceptedRewriteCount,
  acceptedRewriteText,
  createRewriteReview,
  rewriteDecision,
  rewriteHunks,
  updateRewriteHunk,
} from "./rewriteReview";

describe("rewrite review", () => {
  it("keeps undecided blocks as original text and applies selected blocks only", () => {
    const review = createRewriteReview(
      "keep\nbefore\nmiddle\nafter\n",
      "keep\nbefore changed\nmiddle\nafter changed\n"
    );
    const hunks = rewriteHunks(review);

    expect(hunks).toHaveLength(2);
    expect(acceptedRewriteText(review)).toBe("keep\nbefore\nmiddle\nafter\n");

    const oneAccepted = updateRewriteHunk(review, hunks[0].id, "accepted");
    expect(acceptedRewriteCount(oneAccepted)).toBe(1);
    expect(acceptedRewriteText(oneAccepted)).toBe("keep\nbefore changed\nmiddle\nafter\n");

    const noneAccepted = updateRewriteHunk(oneAccepted, hunks[0].id, "discarded");
    expect(acceptedRewriteText(noneAccepted)).toBe("keep\nbefore\nmiddle\nafter\n");
  });

  it("represents a complete replacement as one reviewable block", () => {
    const review = createRewriteReview("old", "new");
    const [hunk] = rewriteHunks(review);

    expect(hunk).toMatchObject({ original: "old", replacement: "new", state: "pending" });
    expect(acceptedRewriteText(updateRewriteHunk(review, hunk.id, "accepted"))).toBe("new");
  });

  it("uses one decision for Tab, the editor button, and the panel button", () => {
    const review = createRewriteReview("one\ntwo\n", "ONE\ntwo\n");
    const [hunk] = rewriteHunks(review);
    expect(rewriteDecision("ONE\ntwo\n", null)).toBe("ONE\ntwo\n");
    expect(rewriteDecision("ONE\ntwo\n", review)).toBeNull();
    expect(rewriteDecision("ONE\ntwo\n", updateRewriteHunk(review, hunk.id, "accepted"))).toBe(
      "ONE\ntwo\n"
    );
  });

  it("keeps unchanged output out of the review list", () => {
    const review = createRewriteReview("same\n", "same\n");
    expect(rewriteHunks(review)).toEqual([]);
    expect(acceptedRewriteText(review)).toBe("same\n");
  });
});
