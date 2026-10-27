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
  { pattern: /^不是文件夹。$/, key: "notAFolder" },
  { pattern: /^没有权限。$/, key: "permissionDenied" },
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
  { pattern: /^文件名不能为空。$/, key: "fileNameEmpty" },
  { pattern: /^文件名无效。$/, key: "fileNameInvalid" },
  { pattern: /^文件名过长。$/, key: "fileNameTooLong" },
  {
    pattern: /^文件名不能包含 \\ \/ : \* \? " < > \| 这些字符。$/,
    key: "fileNameCharacters",
  },
  { pattern: /^文件名包含无效字符。$/, key: "fileNameControl" },
  {
    pattern: /^文件不存在或无法访问：([\s\S]+)$/,
    key: "renameMissing",
    params: (m) => ({ detail: m[1] }),
  },
  {
    pattern: /^无法定位文件所在目录。$/,
    key: "renameNoParent",
  },
  { pattern: /^「([\s\S]+)」已存在。$/, key: "renameExists", params: (m) => ({ name: m[1] }) },
  {
    pattern: /^重命名失败：([\s\S]+)$/,
    key: "renameFailed",
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
  {
    pattern: /^不支持的模型服务：([\s\S]+)$/,
    key: "aiProviderUnsupported",
    params: (m) => ({ id: m[1] }),
  },
  { pattern: /^服务地址无效。$/, key: "aiBaseUrlInvalid" },
  { pattern: /^服务地址只支持 http 或 https。$/, key: "aiBaseUrlScheme" },
  { pattern: /^非本机地址只支持 https。$/, key: "aiRemoteHttp" },
  {
    pattern: /^密钥只发给保存时的服务地址。更换地址需要重新输入密钥。$/,
    key: "aiKeyOriginMismatch",
  },
  {
    pattern: /^密钥还没有绑定服务地址，请在模型服务里重新保存。$/,
    key: "aiKeyUnbound",
  },
  { pattern: /^模型名称不能为空。$/, key: "aiModelEmpty" },
  { pattern: /^消息不能为空。$/, key: "aiMessagesEmpty" },
  {
    pattern: /^不支持的消息角色：([\s\S]+)$/,
    key: "aiRoleUnsupported",
    params: (m) => ({ role: m[1] }),
  },
  { pattern: /^温度必须在 0 到 2 之间。$/, key: "aiTemperature" },
  { pattern: /^生成长度必须大于 0。$/, key: "aiMaxTokens" },
  { pattern: /^已取消。$/, key: "aiCancelled" },
  {
    pattern: /^服务返回 (\d+)：([\s\S]+)$/,
    key: "aiHttp",
    params: (m) => ({ status: m[1], detail: m[2] }),
  },
  {
    pattern: /^无法连接模型服务：([\s\S]+)$/,
    key: "aiNetwork",
    params: (m) => ({ detail: m[1] }),
  },
  {
    pattern: /^模型响应无法解析：([\s\S]+)$/,
    key: "aiProtocol",
    params: (m) => ({ detail: m[1] }),
  },
  {
    pattern: /^模型服务错误：([\s\S]+)$/,
    key: "aiUpstream",
    params: (m) => ({ detail: m[1] }),
  },
  { pattern: /^等待模型响应超时。$/, key: "aiTimeout" },
  { pattern: /^模型中途停止输出，已取消。$/, key: "aiIdle" },
  {
    pattern: /^模型响应超过 (\d+) 分钟，已停止。$/,
    key: "aiTooLong",
    params: (m) => ({ minutes: m[1] }),
  },
  { pattern: /^模型响应中途断开，结果不完整。$/, key: "aiIncomplete" },
  { pattern: /^输出达到长度上限，结果不完整。$/, key: "aiTruncated" },
  { pattern: /^密钥无效或没有权限。$/, key: "aiUnauthorized" },
  {
    pattern: /^15 秒内没有收到模型的第一个字，已取消。可以改用本地模型。$/,
    key: "aiFirstToken",
  },
  { pattern: /^密钥不能为空。$/, key: "aiKeyEmpty" },
  { pattern: /^模型标识无效。$/, key: "aiProfileId" },
  {
    pattern: /^钥匙串操作失败：([\s\S]+)$/,
    key: "aiKeyring",
    params: (m) => ({ detail: m[1] }),
  },
];

const EN: Record<string, string> = {
  readFailed: "Read failed: {detail}",
  notAFile: "The selected path is not a file.",
  notAFolder: "That path is not a folder.",
  permissionDenied: "Permission denied.",
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
  fileNameEmpty: "The file name cannot be empty.",
  fileNameInvalid: "That file name is not valid.",
  fileNameTooLong: "The file name is too long.",
  fileNameCharacters: 'A file name cannot contain \\ / : * ? " < > |',
  fileNameControl: "The file name contains invalid characters.",
  renameMissing: "The file no longer exists or cannot be read: {detail}",
  renameNoParent: "Could not locate the folder that holds this file.",
  renameExists: "“{name}” already exists.",
  renameFailed: "Rename failed: {detail}",
  charsetUnsupported: "Unsupported encoding: {charset}",
  charsetUnrepresentable:
    "The content has characters that {charset} cannot represent; convert it to UTF-8 first.",
  largeNoUtf16: "Read-only large-file preview does not support UTF-16.",
  indexCorrupt: "The line index cache is corrupted.",
  rangeInvalid: "Invalid line range.",
  mmapFailed: "Memory mapping failed: {detail}",
  rangeOutOfBounds: "The line range is beyond the end of the file.",
  aiProviderUnsupported: "Unsupported model provider: {id}",
  aiBaseUrlInvalid: "The model service address is invalid.",
  aiBaseUrlScheme: "The model service address must use http or https.",
  aiRemoteHttp: "Remote addresses only support https.",
  aiKeyOriginMismatch:
    "The key is only sent to the address it was saved with. Enter it again after changing the address.",
  aiKeyUnbound: "This key is not bound to a service address yet. Save it again in Model service.",
  aiModelEmpty: "The model name cannot be empty.",
  aiMessagesEmpty: "The message list cannot be empty.",
  aiRoleUnsupported: "Unsupported message role: {role}",
  aiTemperature: "Temperature must be between 0 and 2.",
  aiMaxTokens: "The generation length must be greater than 0.",
  aiCancelled: "Cancelled.",
  aiHttp: "The model service returned {status}: {detail}",
  aiNetwork: "Could not reach the model service: {detail}",
  aiProtocol: "Could not parse the model response: {detail}",
  aiUpstream: "The model service reported an error: {detail}",
  aiTimeout: "Timed out waiting for the model.",
  aiIdle: "The model stopped sending text, so the request was cancelled.",
  aiTooLong: "The model ran longer than {minutes} minutes, so the request was stopped.",
  aiIncomplete: "The model response ended early, so the result is incomplete.",
  aiTruncated: "The reply hit the length limit and is incomplete.",
  aiUnauthorized: "The API key was rejected or is not allowed.",
  aiFirstToken:
    "No reply arrived within 15 seconds, so the request was cancelled. A local model may respond sooner.",
  aiKeyEmpty: "The API key cannot be empty.",
  aiProfileId: "The model id is invalid.",
  aiKeyring: "Keychain operation failed: {detail}",
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
