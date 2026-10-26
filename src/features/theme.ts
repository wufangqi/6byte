import { useSyncExternalStore } from "react";
import { watchStorageKey } from "../lib/storageSync";

/** Saved appearance. `system` follows the OS light/dark setting. */
export type ThemePreference = "light" | "dark" | "system";

/** Concrete palette applied to the UI. */
export type ResolvedTheme = "light" | "dark";

export const THEME_KEY = "ainative.theme";

const listeners = new Set<() => void>();

let preference: ThemePreference | null = null;
let systemDark = true;
let media: MediaQueryList | null = null;
let unwatchStorage: (() => void) | null = null;

/** Unknown or missing values stay on the original dark appearance. */
export function parseThemePreference(value: string | null | undefined): ThemePreference {
  if (value === "light" || value === "dark" || value === "system") return value;
  return "dark";
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

function readStored(): ThemePreference {
  try {
    return parseThemePreference(localStorage.getItem(THEME_KEY));
  } catch {
    return "dark";
  }
}

function currentPreference(): ThemePreference {
  preference ??= readStored();
  return preference;
}

export function getPreference(): ThemePreference {
  return currentPreference();
}

export function getResolvedTheme(): ResolvedTheme {
  return resolveTheme(currentPreference(), systemDark);
}

function emit(): void {
  for (const listener of listeners) listener();
}

function apply(): void {
  if (typeof document !== "undefined") {
    const next = currentPreference();
    document.documentElement.dataset.theme = next;
    document.documentElement.dataset.resolved = resolveTheme(next, systemDark);
  }
  emit();
}

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* ignore storage errors */
  }
  apply();
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Read the saved choice and keep `data-resolved` in sync with the OS. */
export function installTheme(): void {
  preference = readStored();
  unwatchStorage ??= watchStorageKey(THEME_KEY, () => {
    preference = readStored();
    apply();
  });
  if (typeof window === "undefined" || !window.matchMedia) {
    apply();
    return;
  }
  media ??= window.matchMedia("(prefers-color-scheme: dark)");
  systemDark = media.matches;
  media.addEventListener("change", onSystemTheme);
  apply();
}

function onSystemTheme(event: MediaQueryListEvent): void {
  systemDark = event.matches;
  if (currentPreference() === "system") apply();
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribeTheme, getPreference, () => "dark");
}

export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeTheme, getResolvedTheme, () => "dark");
}
