import { create } from "zustand";

export type DialogVariant = "primary" | "danger" | "ghost";

export interface DialogButton {
  label: string;
  value: string;
  variant?: DialogVariant;
}

export interface DialogRequest {
  title: string;
  message: string;
  buttons: DialogButton[];
}

interface DialogState {
  request: DialogRequest | null;
  resolve: ((value: string | null) => void) | null;
  open(request: DialogRequest): Promise<string | null>;
  choose(value: string | null): void;
}

export const useDialog = create<DialogState>((set, get) => ({
  request: null,
  resolve: null,
  open: (request) => new Promise<string | null>((resolve) => set({ request, resolve })),
  choose: (value) => {
    const resolve = get().resolve;
    set({ request: null, resolve: null });
    resolve?.(value);
  },
}));

/** Show a modal with the given buttons; resolves to the chosen value or `null` (cancel). */
export const ask = (request: DialogRequest): Promise<string | null> =>
  useDialog.getState().open(request);
