import { create } from "zustand";

export interface NamePromptRequest {
  title: string;
  label: string;
  /** Text shown when the input is empty. */
  placeholder?: string;
  initial: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Extension appended when the user types a bare name (e.g. `.md`). */
  keepExtension?: string;
  /** Optional extra check that runs after the built-in file name validation. */
  validate?: (value: string) => string | null;
}

interface NamePromptState {
  request: NamePromptRequest | null;
  resolve: ((value: string | null) => void) | null;
  open(request: NamePromptRequest): Promise<string | null>;
  settle(value: string | null): void;
}

export const useNamePrompt = create<NamePromptState>((set, get) => ({
  request: null,
  resolve: null,
  open: (request) => new Promise<string | null>((resolve) => set({ request, resolve })),
  settle: (value) => {
    const resolve = get().resolve;
    set({ request: null, resolve: null });
    resolve?.(value);
  },
}));

/** Ask for a file name; resolves to the trimmed name, or `null` when cancelled. */
export const askName = (request: NamePromptRequest): Promise<string | null> =>
  useNamePrompt.getState().open(request);
