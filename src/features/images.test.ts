import { describe, expect, it } from "vitest";
import { toDataUri, mimeForPath } from "./images";

describe("mimeForPath", () => {
  it("maps common image extensions", () => {
    expect(mimeForPath("D:/a/shot.png")).toBe("image/png");
    expect(mimeForPath("shot.JPG")).toBe("image/jpeg");
    expect(mimeForPath("shot.jpeg")).toBe("image/jpeg");
    expect(mimeForPath("shot.gif")).toBe("image/gif");
    expect(mimeForPath("shot.webp")).toBe("image/webp");
    expect(mimeForPath("shot.svg")).toBe("image/svg+xml");
  });

  it("falls back for unknown or missing extensions", () => {
    expect(mimeForPath("notes.txt")).toBe("application/octet-stream");
    expect(mimeForPath("no-extension")).toBe("application/octet-stream");
  });
});

describe("toDataUri", () => {
  it("builds a base64 data URI", () => {
    expect(toDataUri("AQID", "image/png")).toBe("data:image/png;base64,AQID");
  });
});
