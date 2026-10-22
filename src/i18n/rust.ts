/**
 * Rust raises user-facing errors in Chinese (the original UI language). The
 * English UI maps the known messages back to English templates; anything we do
 * not know is passed through unchanged, so the failure is never hidden.
 */
import type { Locale } from "./locale";

type Params = Record<string, string | number>;

interface Rule {
  pattern: RegExp;
  key: string;
  params?: (match: RegExpMatchArray) => Params;
}

const RULES: Rule[] = [
  { pattern: /^读取失败：([\s\S]+)$/, key: "readFailed", params: (m) => ({ detail: m[1] }) },
  {
    pattern: /^文件过大（([\d.]+) MB），当前版本上限为 ([\d.]+) MB；大文件支持将在 M1 提供。$/,
    key: "tooLarge",
    params: (m) => ({ size: m[1], limit: m[2] }),
  },
  {
    pattern: /^文件过大（([\d.]+) MB），只读预览上限为 ([\d.]+) MB。$/,
    key: "tooLargeReadonly",
    params: (m) => ({ size: m[1], limit: m[2] }),
  },
  { pattern: /^所选路径不是文件。$/, key: "notAFile" },
  { pattern: /^该文件包含二进制内容（NUL 字节），已拒绝以文本方式打开。$/, key: "binary" },
  {
    pattern: /^该文件在打开时包含无法解码的字节，直接保存会用替换字符覆盖原数据。$/,
    key: "lossyOverwrite",
  },
  { pattern: /^保存失败：([\s\S]+)$/, key: "saveFailed", params: (m) => ({ detail: m[1] }) },
  { pattern: /^图片数据为空。$/, key: "imageEmpty" },
  {
    pattern: /^图片过大（上限 ([\d.]+) MB）。$/,
    key: "imageTooLarge",
    params: (m) => ({ limit: m[1] }),
  },
  { pattern: /^目标文件夹不存在。$/, key: "folderMissing" },
  {
    pattern: /^创建 assets 目录失败：([\s\S]+)$/,
    key: "assetsFailed",
    params: (m) => ({ detail: m[1] }),
  },
  {
    pattern: /^写入图片失败：([\s\S]+)$/,
    key: "imageWriteFailed",
    params: (m) => ({ detail: m[1] }),
  },
  { pattern: /^图片文件名无效。$/, key: "imageNameInvalid" },
  { pattern: /^搜索内容不能为空。$/, key: "grepEmpty" },
  {
    pattern: /^正则表达式无效：([\s\S]+)$/,
    key: "regexInvalid",
    params: (m) => ({ detail: m[1] }),
  },
  { pattern: /^搜索目录不存在或不是文件夹。$/, key: "grepRootMissing" },
  { pattern: /^无法监听没有父目录的路径。$/, key: "watchNoParent" },
  { pattern: /^监听状态已损坏$/, key: "watchBroken" },
  {
    pattern: /^无法启动文件监听：([\s\S]+)$/,
    key: "watchStartFailed",
    params: (m) => ({ detail: m[1] }),
  },
  {
    pattern: /^无法监听目录 ([\s\S]+)：([\s\S]+)$/,
    key: "watchDirFailed",
    params: (m) => ({ path: m[1], detail: m[2] }),
  },
  {
    pattern: /^无法解析路径：([\s\S]+)$/,
    key: "pathParseFailed",
    params: (m) => ({ detail: m[1] }),
  },
  {
    pattern: /^不支持的编码：([\s\S]+)$/,
    key: "charsetUnsupported",
    params: (m) => ({ charset: m[1] }),
  },
  {
    pattern: /^内容包含 ([\s\S]+) 无法表示的字符，请先转换为 UTF-8$/,
    key: "charsetUnrepresentable",
    params: (m) => ({ charset: m[1] }),
  },
  { pattern: /^大文件只读预览暂不支持 UTF-16 编码$/, key: "largeNoUtf16" },
  { pattern: /^索引缓存已损坏$/, key: "indexCorrupt" },
  { pattern: /^读取区间无效。$/, key: "rangeInvalid" },
  {
    pattern: /^内存映射失败：([\s\S]+)$/,
    key: "mmapFailed",
    params: (m) => ({ detail: m[1] }),
  },
  { pattern: /^读取区间超出文件大小。$/, key: "rangeOutOfBounds" },
];

const EN: Record<string, string> = {
  readFailed: "Read failed: {detail}",
  notAFile: "The selected path is not a file.",
  tooLarge: "File is too large ({size} MB); the current limit is {limit} MB.",
  tooLargeReadonly: "File is too large ({size} MB); the read-only preview limit is {limit} MB.",
  binary: "The file contains binary data (NUL byte); it cannot be opened as text.",
  lossyOverwrite:
    "This file contained undecodable bytes when it was opened; saving would overwrite the original data with replacement characters.",
  saveFailed: "Save failed: {detail}",
  imageEmpty: "The image data is empty.",
  imageTooLarge: "The image is too large (limit {limit} MB).",
  folderMissing: "The target folder does not exist.",
  assetsFailed: "Could not create the assets folder: {detail}",
  imageWriteFailed: "Could not write the image: {detail}",
  imageNameInvalid: "Invalid image file name.",
  grepEmpty: "The search pattern cannot be empty.",
  regexInvalid: "Invalid regular expression: {detail}",
  grepRootMissing: "The search folder does not exist or is not a folder.",
  watchNoParent: "Cannot watch a path without a parent folder.",
  watchBroken: "Watch state is corrupted.",
  watchStartFailed: "Could not start file watching: {detail}",
  watchDirFailed: "Could not watch folder {path}: {detail}",
  pathParseFailed: "Could not parse the path: {detail}",
  charsetUnsupported: "Unsupported encoding: {charset}",
  charsetUnrepresentable:
    "The content has characters that {charset} cannot represent; convert it to UTF-8 first.",
  largeNoUtf16: "Read-only large-file preview does not support UTF-16.",
  indexCorrupt: "The line index cache is corrupted.",
  rangeInvalid: "Invalid line range.",
  mmapFailed: "Memory mapping failed: {detail}",
  rangeOutOfBounds: "The line range is beyond the end of the file.",
};

/** Map a Chinese Rust error onto the current language; unknown errors pass through. */
export function localizeRustMessage(message: string, locale: Locale): string {
  if (locale === "zh") return message;
  const text = message.trim();
  for (const rule of RULES) {
    const match = text.match(rule.pattern);
    if (!match) continue;
    const template = EN[rule.key];
    if (!template) continue;
    const params: Params = rule.params ? rule.params(match) : {};
    return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
      params[name] === undefined ? whole : String(params[name])
    );
  }
  return message;
}
