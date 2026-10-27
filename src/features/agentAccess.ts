/**
 * What the read-only agent may open. Anything it reads is sent to the model host,
 * so hidden files, key material and the user's own list stay out of reach.
 */

export const AGENT_DENY_KEY = "ainative.agentDeny";

const MAX_RULES = 100;
const MAX_RULE_CHARS = 200;

const SECRET_EXTENSIONS = new Set([
  "pem",
  "key",
  "p12",
  "pfx",
  "jks",
  "keystore",
  "kdbx",
  "ppk",
  "env",
]);
const SECRET_KEY_PREFIXES = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
const SECRET_NAMES = new Set(["credentials", "secrets", "secret"]);
const SECRET_NAME_EXTENSIONS = new Set(["", "json", "yaml", "yml", "toml", "ini", "txt", "xml"]);

export type BlockReason = "hidden" | "secret" | "listed" | "outside";

/** One rule per line. Blank lines and `#` comments are dropped. */
export function parseDenylist(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const rules: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const rule = line.trim();
    if (!rule || rule.startsWith("#")) continue;
    const clipped = rule.slice(0, MAX_RULE_CHARS);
    if (!rules.includes(clipped)) rules.push(clipped);
    if (rules.length >= MAX_RULES) break;
  }
  return rules;
}

export function loadDenylistText(): string {
  try {
    return localStorage.getItem(AGENT_DENY_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveDenylistText(text: string): void {
  localStorage.setItem(AGENT_DENY_KEY, text);
}

export function loadDenylist(): string[] {
  return parseDenylist(loadDenylistText());
}

function unify(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\/\/\?\//, "")
    .replace(/\/+$/, "");
}

/** Path segments under the root, or null when the path is not under it. */
export function segmentsUnder(root: string, path: string): string[] | null {
  const base = unify(root);
  const full = unify(path);
  if (!base || full.length < base.length) return null;
  if (full.slice(0, base.length).toLowerCase() !== base.toLowerCase()) return null;
  const rest = full.slice(base.length);
  if (rest && !rest.startsWith("/")) return null;
  const segments = rest.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "..")) return null;
  return segments.filter((segment) => segment !== ".");
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  let out = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        out += ".*";
        index += 1;
      } else out += "[^/]*";
    } else if (char === "?") out += "[^/]";
    else out += escapeRegex(char);
  }
  return new RegExp(`^${out}$`, "i");
}

function listedBy(rule: string, segments: string[]): boolean {
  const pattern = unify(rule).replace(/^\.?\/+/, "");
  if (!pattern) return false;
  const regex = globToRegex(pattern);
  if (!pattern.includes("/")) return segments.some((segment) => regex.test(segment));
  // A folder rule covers everything under it.
  for (let end = 1; end <= segments.length; end += 1) {
    if (regex.test(segments.slice(0, end).join("/"))) return true;
  }
  return false;
}

function secretName(segment: string): boolean {
  const lower = segment.toLowerCase();
  if (SECRET_KEY_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  const dot = lower.lastIndexOf(".");
  const extension = dot > 0 ? lower.slice(dot + 1) : "";
  if (extension && SECRET_EXTENSIONS.has(extension)) return true;
  const stem = lower.split(".")[0] ?? "";
  return SECRET_NAMES.has(stem) && SECRET_NAME_EXTENSIONS.has(extension);
}

/**
 * Why the agent may not open `path`, or null when it may. A path that cannot be
 * placed under the root is refused as well.
 */
export function blockedReason(
  root: string,
  path: string,
  denylist: readonly string[] = []
): BlockReason | null {
  const segments = segmentsUnder(root, path);
  if (!segments) return "outside";
  if (segments.some((segment) => segment.startsWith("."))) return "hidden";
  if (segments.some(secretName)) return "secret";
  if (denylist.some((rule) => listedBy(rule, segments))) return "listed";
  return null;
}

export const BLOCKED_MESSAGE = "拒绝：这是隐藏文件、密钥文件或在禁读名单里，不会发给模型。";
