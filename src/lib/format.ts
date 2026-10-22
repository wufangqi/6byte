import { getLocale, t } from "../i18n/locale";

/** Human readable byte size, e.g. `1.5 KB`. */
export const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

/** Local timestamp for a millisecond epoch value, following the UI language. */
export const formatTime = (ms: number): string =>
  ms > 0
    ? new Date(ms).toLocaleString(getLocale() === "zh" ? "zh-CN" : "en-US")
    : t("format.unknownTime");
