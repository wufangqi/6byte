/**
 * Pure validation for {@link ForwardSpec}.
 *
 * Port 0 is legal (system-assigned). Host strings must be non-empty.
 * The kind discriminant must be one of "local" | "remote" | "dynamic".
 */
import type { ForwardSpec } from "../../ipc/ssh";

export interface ForwardSpecError {
  field: string;
  message: string;
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 0 && port <= 65535;
}

/** Validate a ForwardSpec. Returns an empty array when valid. */
export function validateForwardSpec(spec: ForwardSpec): ForwardSpecError[] {
  const errors: ForwardSpecError[] = [];

  if (spec.kind === "local") {
    if (!validPort(spec.localPort)) {
      errors.push({ field: "localPort", message: "portRange" });
    }
    if (!spec.remoteHost.trim()) {
      errors.push({ field: "remoteHost", message: "hostEmpty" });
    }
    if (!validPort(spec.remotePort)) {
      errors.push({ field: "remotePort", message: "portRange" });
    }
  } else if (spec.kind === "remote") {
    if (!validPort(spec.remotePort)) {
      errors.push({ field: "remotePort", message: "portRange" });
    }
    if (!spec.localHost.trim()) {
      errors.push({ field: "localHost", message: "hostEmpty" });
    }
    if (!validPort(spec.localPort)) {
      errors.push({ field: "localPort", message: "portRange" });
    }
  } else if (spec.kind === "dynamic") {
    if (!validPort(spec.localPort)) {
      errors.push({ field: "localPort", message: "portRange" });
    }
  } else {
    errors.push({ field: "kind", message: "invalidKind" });
  }

  return errors;
}
