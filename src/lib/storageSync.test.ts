// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  COMPLETION_KEY,
  loadCompletionSettings,
  subscribeCompletion,
} from "../features/completionSettings";
import { THEME_KEY, getPreference, installTheme } from "../features/theme";
import { LOCALE_KEY, getLocale, installLocale } from "../i18n/locale";

describe("storage events from another window", () => {
  it("reloads theme, locale, and completion settings", () => {
    installTheme();
    installLocale();
    let completionReads = 0;
    const stop = subscribeCompletion(() => {
      completionReads += 1;
    });

    localStorage.setItem(THEME_KEY, "light");
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY }));
    expect(getPreference()).toBe("light");

    localStorage.setItem(LOCALE_KEY, "en");
    window.dispatchEvent(new StorageEvent("storage", { key: LOCALE_KEY }));
    expect(getLocale()).toBe("en");

    localStorage.setItem(
      COMPLETION_KEY,
      JSON.stringify({ enabled: true, providerId: "p", modelId: "m" })
    );
    window.dispatchEvent(new StorageEvent("storage", { key: COMPLETION_KEY }));
    expect(completionReads).toBe(1);
    expect(loadCompletionSettings().enabled).toBe(true);

    window.dispatchEvent(new StorageEvent("storage", { key: "ainative.other" }));
    expect(completionReads).toBe(1);
    stop();
  });
});
