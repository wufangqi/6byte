/**
 * An unaccepted rewrite must not reach disk.
 *
 * The proposal lives in editor decorations, not the buffer. Saving still
 * dismisses it first so a later accept cannot apply a reply the user
 * thought they had discarded by saving.
 */

type Gate = {
  tabId: string;
  dismiss: () => void;
};

let gate: Gate | null = null;

export function armRewriteGate(tabId: string, dismiss: () => void): void {
  gate = { tabId, dismiss };
}

export function disarmRewriteGate(tabId: string): void {
  if (gate?.tabId === tabId) gate = null;
}

/** Drop the proposal for `tabId` before the buffer is written. */
export function dismissRewriteForSave(tabId: string): void {
  if (gate?.tabId !== tabId) return;
  const dismiss = gate.dismiss;
  gate = null;
  dismiss();
}
