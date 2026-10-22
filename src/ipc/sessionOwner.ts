/**
 * The window labeled `main` keeps the list of files to reopen.
 * Extra windows start empty and must not overwrite that list.
 * A missing label means the browser preview, which has a single window.
 */
export function windowOwnsSession(label: string | null | undefined): boolean {
  return label == null || label === "" || label === "main";
}
