/**
 * Views whose DOM is being torn down.
 *
 * CodeMirror reads that teardown as an edit and would replace the cached
 * document with the few lines still on screen. Updates from these views are
 * not written back.
 */
const suppressed = new WeakSet<object>();

export function suppressViewPersistence(view: object): void {
  suppressed.add(view);
}

export function viewPersistenceSuppressed(view: object): boolean {
  return suppressed.has(view);
}
