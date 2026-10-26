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
    expect(localizeRustMessage("服务返回 401：bad key", "en")).toBe(
      "The model service returned 401: bad key"
    );
    expect(localizeRustMessage("已取消。", "en")).toBe("Cancelled.");
    expect(localizeRustMessage("等待模型响应超时。", "en")).toBe(
      "Timed out waiting for the model."
    );
    expect(localizeRustMessage("模型中途停止输出，已取消。", "en")).toBe(
      "The model stopped sending text, so the request was cancelled."
    );
    expect(localizeRustMessage("模型响应超过 4 分钟，已停止。", "en")).toBe(
      "The model ran longer than 4 minutes, so the request was stopped."
    );
    expect(localizeRustMessage("模型响应中途断开，结果不完整。", "en")).toBe(
      "The model response ended early, so the result is incomplete."
    );
    expect(localizeRustMessage("输出达到长度上限，结果不完整。", "en")).toBe(
      "The reply hit the length limit and is incomplete."
    );
    expect(localizeRustMessage("密钥无效或没有权限。", "en")).toBe(
      "The API key was rejected or is not allowed."
    );
    expect(localizeRustMessage("服务返回 429：slow down", "en")).toBe(
      "The model service returned 429: slow down"
    );
    expect(localizeRustMessage("无法连接模型服务：connection reset", "en")).toBe(
      "Could not reach the model service: connection reset"
    );
    expect(localizeRustMessage("模型响应无法解析：eof", "en")).toBe(
      "Could not parse the model response: eof"
    );
    expect(localizeRustMessage("模型服务错误：overloaded", "en")).toBe(
      "The model service reported an error: overloaded"
    );
    expect(
      localizeRustMessage("15 秒内没有收到模型的第一个字，已取消。可以改用本地模型。", "en")
    ).toBe(
      "No reply arrived within 15 seconds, so the request was cancelled. A local model may respond sooner."
    );
    expect(localizeRustMessage("密钥不能为空。", "en")).toBe("The API key cannot be empty.");
    expect(localizeRustMessage("非本机地址只支持 https。", "en")).toBe(
      "Remote addresses only support https."
    );
    expect(
      localizeRustMessage("密钥只发给保存时的服务地址。更换地址需要重新输入密钥。", "en")
    ).toBe(
      "The key is only sent to the address it was saved with. Enter it again after changing the address."
    );
    expect(localizeRustMessage("密钥还没有绑定服务地址，请在模型服务里重新保存。", "en")).toBe(
      "This key is not bound to a service address yet. Save it again in Model service."
    );
    expect(localizeRustMessage("不是文件夹。", "en")).toBe("That path is not a folder.");
    expect(localizeRustMessage("没有权限。", "en")).toBe("Permission denied.");
    expect(localizeRustMessage("模型标识无效。", "en")).toBe("The model id is invalid.");
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
