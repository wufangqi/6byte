import { describe, expect, it } from "vitest";
import type { ForwardSpec } from "../../ipc/ssh";
import { validateForwardSpec } from "./forwardSpec";

describe("validateForwardSpec", () => {
  it("accepts a valid local forward", () => {
    const spec: ForwardSpec = {
      kind: "local",
      localPort: 8080,
      remoteHost: "localhost",
      remotePort: 80,
    };
    expect(validateForwardSpec(spec)).toEqual([]);
  });

  it("accepts port 0 (system-assigned)", () => {
    const spec: ForwardSpec = {
      kind: "local",
      localPort: 0,
      remoteHost: "localhost",
      remotePort: 80,
    };
    expect(validateForwardSpec(spec)).toEqual([]);
  });

  it("rejects port out of range", () => {
    const spec: ForwardSpec = {
      kind: "local",
      localPort: 70000,
      remoteHost: "localhost",
      remotePort: 80,
    };
    const errors = validateForwardSpec(spec);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].field).toBe("localPort");
  });

  it("rejects negative port", () => {
    const spec: ForwardSpec = { kind: "dynamic", localPort: -1 };
    const errors = validateForwardSpec(spec);
    expect(errors.some((e) => e.field === "localPort")).toBe(true);
  });

  it("rejects empty host for local forward", () => {
    const spec: ForwardSpec = { kind: "local", localPort: 8080, remoteHost: "", remotePort: 80 };
    const errors = validateForwardSpec(spec);
    expect(errors.some((e) => e.field === "remoteHost")).toBe(true);
  });

  it("accepts a valid remote forward", () => {
    const spec: ForwardSpec = {
      kind: "remote",
      remotePort: 3000,
      localHost: "127.0.0.1",
      localPort: 3000,
    };
    expect(validateForwardSpec(spec)).toEqual([]);
  });

  it("rejects empty localHost for remote forward", () => {
    const spec: ForwardSpec = {
      kind: "remote",
      remotePort: 3000,
      localHost: "  ",
      localPort: 3000,
    };
    const errors = validateForwardSpec(spec);
    expect(errors.some((e) => e.field === "localHost")).toBe(true);
  });

  it("accepts a valid dynamic forward", () => {
    const spec: ForwardSpec = { kind: "dynamic", localPort: 1080 };
    expect(validateForwardSpec(spec)).toEqual([]);
  });
});
