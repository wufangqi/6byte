/** Remote (SSH) images must resolve through the SSH reader, not the local one. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const readBinaryBase64 = vi.fn();
const sshReadBinaryBase64 = vi.fn();

vi.mock("../ipc/api", () => ({
  readBinaryBase64: (...args: unknown[]) => readBinaryBase64(...args),
}));

vi.mock("../ipc/ssh", () => ({
  sshReadBinaryBase64: (...args: unknown[]) => sshReadBinaryBase64(...args),
}));

import { clearImageCache, loadImageDataUrl, mimeForPath } from "./images";

describe("loadImageDataUrl", () => {
  beforeEach(() => {
    readBinaryBase64.mockReset();
    sshReadBinaryBase64.mockReset();
    clearImageCache();
  });

  it("reads a local path through the local reader", async () => {
    readBinaryBase64.mockResolvedValue("bG9jYWw=");
    const uri = await loadImageDataUrl("D:/docs/a.png");
    expect(readBinaryBase64).toHaveBeenCalledWith("D:/docs/a.png");
    expect(sshReadBinaryBase64).not.toHaveBeenCalled();
    expect(uri).toBe("data:image/png;base64,bG9jYWw=");
  });

  it("reads an ssh:// image through the remote reader", async () => {
    sshReadBinaryBase64.mockResolvedValue("cmVtb3Rl");
    const uri = await loadImageDataUrl("ssh://p1/home/zx/assets/shot.png");
    expect(sshReadBinaryBase64).toHaveBeenCalledWith("p1", "/home/zx/assets/shot.png");
    expect(readBinaryBase64).not.toHaveBeenCalled();
    expect(uri).toBe("data:image/png;base64,cmVtb3Rl");
  });

  it("resolves .. segments before asking the remote side", async () => {
    sshReadBinaryBase64.mockResolvedValue("eA==");
    await loadImageDataUrl("ssh://p1/home/zx/docs/../img/a.png");
    expect(sshReadBinaryBase64).toHaveBeenCalledWith("p1", "/home/zx/img/a.png");
  });

  it("caches per path and returns null on failure", async () => {
    sshReadBinaryBase64.mockResolvedValueOnce("eA==");
    await loadImageDataUrl("ssh://p1/a.png");
    await loadImageDataUrl("ssh://p1/a.png");
    expect(sshReadBinaryBase64).toHaveBeenCalledTimes(1);

    sshReadBinaryBase64.mockRejectedValueOnce(new Error("boom"));
    expect(await loadImageDataUrl("ssh://p1/missing.png")).toBeNull();
  });

  it("keeps the extension-based mime for remote paths", () => {
    expect(mimeForPath("ssh://p1/home/zx/a.svg")).toBe("image/svg+xml");
  });
});
