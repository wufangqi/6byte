// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCALE_KEY, getLocale, installLocale, parseLocale, setLocale, t, tp } from "./locale";
import { CATALOGS, interpolate, translate, translatePlural } from "./messages";
import { localizeRustMessage } from "./rust";
import { localizeError } from "./index";

const baseKey = (key: string) => key.replace(/_(one|other)$/, "");

const baseKeys = (catalog: Record<string, string>) => new Set(Object.keys(catalog).map(baseKey));

beforeEach(() => {
  localStorage.clear();
  installLocale();
});

afterEach(() => {
  localStorage.clear();
  installLocale();
});

describe("message catalogs", () => {
  it("covers the same keys in Chinese and English (plural suffixes included)", () => {
    const zh = baseKeys(CATALOGS.zh);
    const en = baseKeys(CATALOGS.en);
    const missingInEn = [...zh].filter((key) => !en.has(key));
    const missingInZh = [...en].filter((key) => !zh.has(key));
    expect(missingInEn).toEqual([]);
    expect(missingInZh).toEqual([]);
  });

  it("defines both plural forms for every English plural key", () => {
    // Every English key that ends in a plural suffix must also have its sibling.
    for (const key of Object.keys(CATALOGS.en)) {
      const match = key.match(/_(one|other)$/);
      if (!match) continue;
      const sibling = key.replace(/_(one|other)$/, match[1] === "one" ? "_other" : "_one");
      expect(CATALOGS.en[sibling], `missing sibling for ${key}`).toBeTruthy();
    }
    expect(CATALOGS.en["status.lines_one"]).toBe("{count} line");
    expect(CATALOGS.en["status.lines_other"]).toBe("{count} lines");
  });

  it("interpolates placeholders without touching unknown ones", () => {
    expect(interpolate("a {x} b {y}", { x: 1 })).toBe("a 1 b {y}");
    expect(translate("zh", "app.paste.saved", { path: "assets/a.png" })).toBe(
      "已保存图片：assets/a.png"
    );
    expect(translate("en", "app.paste.saved", { path: "assets/a.png" })).toBe(
      "Image saved: assets/a.png"
    );
  });

  it("picks English plural forms and keeps Chinese singular form", () => {
    expect(translatePlural("en", "status.lines", 1)).toBe("1 line");
    expect(translatePlural("en", "status.lines", 2)).toBe("2 lines");
    expect(translatePlural("zh", "status.lines", 1)).toBe("1 行");
    expect(translatePlural("zh", "status.lines", 2)).toBe("2 行");
  });
});

describe("locale state", () => {
  it("defaults to Chinese and persists the choice", () => {
    expect(parseLocale(null)).toBe("zh");
    expect(parseLocale("en")).toBe("en");
    expect(getLocale()).toBe("zh");
    expect(t("menu.file")).toBe("文件");

    setLocale("en");
    expect(localStorage.getItem(LOCALE_KEY)).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(t("menu.file")).toBe("File");
    expect(tp("status.lines", 2)).toBe("2 lines");

    installLocale();
    expect(getLocale()).toBe("en");

    setLocale("zh");
    expect(getLocale()).toBe("zh");
    expect(t("menu.file")).toBe("文件");
    expect(document.documentElement.lang).toBe("zh-CN");
  });
});

describe("Rust error localisation", () => {
  it("maps known Chinese errors to English", () => {
    expect(localizeRustMessage("读取失败：拒绝访问", "en")).toBe("Read failed: 拒绝访问");
    expect(
      localizeRustMessage("该文件包含二进制内容（NUL 字节），已拒绝以文本方式打开。", "en")
    ).toBe("The file contains binary data (NUL byte); it cannot be opened as text.");
    expect(localizeRustMessage("不支持的编码：GBK", "en")).toBe("Unsupported encoding: GBK");
    expect(localizeRustMessage("搜索内容不能为空。", "en")).toBe(
      "The search pattern cannot be empty."
    );
    expect(localizeRustMessage("文件过大（20.5 MB），只读预览上限为 20 MB。", "en")).toBe(
      "File is too large (20.5 MB); the read-only preview limit is 20 MB."
    );
  });

  it("leaves Chinese locale and unknown messages untouched", () => {
    expect(localizeRustMessage("搜索内容不能为空。", "zh")).toBe("搜索内容不能为空。");
    expect(localizeRustMessage("完全未知的错误", "en")).toBe("完全未知的错误");
  });

  it("localizes errors thrown through the helper", () => {
    setLocale("en");
    expect(localizeError(new Error("正则表达式无效：unclosed group"))).toBe(
      "Invalid regular expression: unclosed group"
    );
    setLocale("zh");
    expect(localizeError(new Error("正则表达式无效：unclosed group"))).toBe(
      "正则表达式无效：unclosed group"
    );
  });
});
