/** Extension used by Ctrl+N and the welcome-page new-file action. */
export const NEW_FILE_FORMAT_KEY = "ainative.newFileFormat";

export const NEW_FILE_FORMATS = ["txt", "md"] as const;
export type NewFileFormat = (typeof NEW_FILE_FORMATS)[number];

export function parseNewFileFormat(value: string | null | undefined): NewFileFormat {
  return value === "md" ? "md" : "txt";
}

export function loadNewFileFormat(): NewFileFormat {
  try {
    if (typeof localStorage === "undefined") return "txt";
    return parseNewFileFormat(localStorage.getItem(NEW_FILE_FORMAT_KEY));
  } catch {
    return "txt";
  }
}

export function saveNewFileFormat(format: NewFileFormat): void {
  localStorage.setItem(NEW_FILE_FORMAT_KEY, format);
}
