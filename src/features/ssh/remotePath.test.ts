import { describe, expect, it } from "vitest";
import {
  buildSshUri,
  isSshUri,
  parseSshUri,
  posixBasename,
  posixJoin,
  posixNormalize,
  posixParentDir,
} from "./remotePath";

describe("isSshUri", () => {
  it("returns true for valid SSH URIs", () => {
    expect(isSshUri("ssh://abc-123/home/user/file.txt")).toBe(true);
  });

  it("returns false for local paths", () => {
    expect(isSshUri("/home/user/file.txt")).toBe(false);
    expect(isSshUri("C:\\Users\\file.txt")).toBe(false);
  });
});

describe("parseSshUri", () => {
  it("parses a well-formed URI", () => {
    const result = parseSshUri("ssh://my-profile/home/user/docs/readme.md");
    expect(result).toEqual({ profileId: "my-profile", remotePath: "/home/user/docs/readme.md" });
  });

  it("returns null for non-SSH strings", () => {
    expect(parseSshUri("/local/path")).toBeNull();
    expect(parseSshUri("")).toBeNull();
  });

  it("returns null when profile id is missing", () => {
    expect(parseSshUri("ssh:///home/user")).toBeNull();
  });

  it("returns null when there is no slash after profile id", () => {
    expect(parseSshUri("ssh://profile-only")).toBeNull();
  });
});

describe("buildSshUri", () => {
  it("joins profile id and path", () => {
    expect(buildSshUri("prof-1", "/etc/config")).toBe("ssh://prof-1/etc/config");
  });

  it("adds leading slash if missing", () => {
    expect(buildSshUri("prof-1", "etc/config")).toBe("ssh://prof-1/etc/config");
  });
});

describe("posixJoin", () => {
  it("joins two segments", () => {
    expect(posixJoin("/home/user", "docs")).toBe("/home/user/docs");
  });

  it("collapses duplicate slashes", () => {
    expect(posixJoin("/home/user/", "/docs")).toBe("/home/user/docs");
  });

  it("handles empty strings", () => {
    expect(posixJoin("", "/foo")).toBe("/foo");
    expect(posixJoin("/foo", "")).toBe("/foo");
  });
});

describe("posixNormalize", () => {
  it("resolves . and ..", () => {
    expect(posixNormalize("/home/user/../user/./docs")).toBe("/home/user/docs");
  });

  it("does not go above root", () => {
    expect(posixNormalize("/../../etc")).toBe("/etc");
  });

  it("preserves relative ..", () => {
    expect(posixNormalize("../foo/bar")).toBe("../foo/bar");
  });

  it("collapses duplicate slashes", () => {
    expect(posixNormalize("//home///user//")).toBe("/home/user");
  });
});

describe("posixBasename", () => {
  it("returns the last segment", () => {
    expect(posixBasename("/home/user/file.txt")).toBe("file.txt");
  });

  it("returns the name for a bare name", () => {
    expect(posixBasename("readme.md")).toBe("readme.md");
  });
});

describe("posixParentDir", () => {
  it("returns the parent directory", () => {
    expect(posixParentDir("/home/user/file.txt")).toBe("/home/user");
  });

  it("returns / for root-level entries", () => {
    expect(posixParentDir("/etc")).toBe("/");
  });

  it("returns / for root itself", () => {
    expect(posixParentDir("/")).toBe("/");
  });
});
