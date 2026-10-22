import { useCallback, useMemo, useSyncExternalStore } from "react";
import { type Translate, type TranslatePlural, translate, translatePlural } from "./messages";

/** UI language. Persisted as-is; defaults to Chinese, matching the app's origin. */
export type Locale = "zh" | "en";

export const LOCALE_KEY = "ainative.locale";
export const LOCALES: Locale[] = ["zh", "en"];

export function localeName(locale: Locale): string {
  return locale === "zh" ? "中文" : "English";
}

const listeners = new Set<() => void>();

let locale: Locale | null = null;

/** Unknown or missing values fall back to Chinese. */
export function parseLocale(value: string | null | undefined): Locale {
  return value === "en" ? "en" : "zh";
}

function readStored(): Locale {
  try {
    return parseLocale(localStorage.getItem(LOCALE_KEY));
  } catch {
    return "zh";
  }
}

function currentLocale(): Locale {
  locale ??= readStored();
  return locale;
}

export function getLocale(): Locale {
  return currentLocale();
}

function emit(): void {
  for (const listener of listeners) listener();
}

function apply(): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = currentLocale() === "zh" ? "zh-CN" : "en";
    document.documentElement.dataset.locale = currentLocale();
  }
  emit();
}

export function setLocale(next: Locale): void {
  locale = parseLocale(next);
  try {
    localStorage.setItem(LOCALE_KEY, locale);
  } catch {
    /* ignore storage errors */
  }
  apply();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Read the stored language once at startup and mirror it onto `<html>`. */
export function installLocale(): void {
  locale = readStored();
  apply();
}

/** Translate outside React (stores, IPC wrappers, formatters). */
export function t(key: string, params?: Record<string, string | number>): string {
  return translate(currentLocale(), key, params);
}

/** Plural translation outside React. */
export function tp(key: string, count: number, params?: Record<string, string | number>): string {
  return translatePlural(currentLocale(), key, count, params);
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, () => "zh");
}

export interface I18n {
  locale: Locale;
  t: Translate;
  tp: TranslatePlural;
}

/** React binding: re-renders the component when the language changes. */
export function useI18n(): I18n {
  const locale = useLocale();
  const t = useCallback<Translate>((key, params) => translate(locale, key, params), [locale]);
  const tp = useCallback<TranslatePlural>(
    (key, count, params) => translatePlural(locale, key, count, params),
    [locale]
  );
  return useMemo(() => ({ locale, t, tp }), [locale, t, tp]);
}
