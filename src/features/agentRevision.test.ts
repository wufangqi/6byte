import { describe, expect, it } from "vitest";
import { placeCandidate, RevisionLog } from "./agentRevision";

describe("candidate revision", () => {
  it("keeps a range when nothing changed", () => {
    const log = new RevisionLog();
    expect(placeCandidate(log, 0, 6, 11, 20)).toEqual({
      status: "offered",
      from: 6,
      to: 11,
      revision: 0,
    });
  });

  it("shifts a range when the person types before it", () => {
    const log = new RevisionLog();
    log.note([{ from: 0, to: 0, insert: 2 }]);
    expect(placeCandidate(log, 0, 6, 11, 22)).toEqual({
      status: "offered",
      from: 8,
      to: 13,
      revision: 1,
    });
  });

  it("leaves a range when the person types after it, including at its end", () => {
    const log = new RevisionLog();
    log.note([{ from: 11, to: 11, insert: 3 }]);
    log.note([{ from: 40, to: 44, insert: 0 }]);
    expect(placeCandidate(log, 0, 6, 11, 30)).toEqual({
      status: "offered",
      from: 6,
      to: 11,
      revision: 2,
    });
  });

  it("shifts for an insertion exactly at the start and for a deletion just before it", () => {
    const log = new RevisionLog();
    log.note([{ from: 6, to: 6, insert: 1 }]);
    log.note([{ from: 0, to: 2, insert: 0 }]);
    expect(placeCandidate(log, 0, 6, 11, 20)).toEqual({
      status: "offered",
      from: 5,
      to: 10,
      revision: 2,
    });
  });

  it("drops a candidate when an edit touches the range", () => {
    const log = new RevisionLog();
    log.note([{ from: 0, to: 0, insert: 2 }]);
    log.note([{ from: 8, to: 9, insert: 1 }]);
    expect(placeCandidate(log, 0, 6, 11, 40)).toEqual({ status: "stale", revision: 2 });
  });

  it("drops a candidate whose revision was not observed", () => {
    const log = new RevisionLog();
    log.note([{ from: 0, to: 0, insert: 1 }]);
    expect(placeCandidate(log, 4, 1, 2, 10)).toEqual({ status: "stale", revision: 1 });
  });

  it("drops a range that no longer fits the document", () => {
    const log = new RevisionLog();
    expect(placeCandidate(log, 0, 6, 11, 8)).toEqual({ status: "stale", revision: 0 });
  });

  it("forgets edits that fall out of the retained window", () => {
    const log = new RevisionLog(2);
    log.note([{ from: 0, to: 0, insert: 1 }]);
    log.note([{ from: 0, to: 0, insert: 1 }]);
    log.note([{ from: 0, to: 0, insert: 1 }]);
    expect(placeCandidate(log, 0, 6, 11, 30)).toEqual({ status: "stale", revision: 3 });
    expect(placeCandidate(log, 1, 6, 11, 30)).toEqual({
      status: "offered",
      from: 8,
      to: 13,
      revision: 3,
    });
  });

  it("invalidates older revisions when the document is replaced", () => {
    const log = new RevisionLog();
    log.note([{ from: 0, to: 0, insert: 1 }]);
    log.invalidate();
    expect(placeCandidate(log, 1, 0, 4, 10)).toEqual({ status: "stale", revision: 2 });
    expect(placeCandidate(log, 2, 0, 4, 10)).toEqual({
      status: "offered",
      from: 0,
      to: 4,
      revision: 2,
    });
  });
});
