// Extract the CHANGELOG section for a release tag and expose it as a
// step output (`body`) for tauri-action.
// Usage: node scripts/release-notes.mjs v0.1.7
import { appendFileSync, readFileSync } from "node:fs";

const tag = process.argv[2] ?? "";
const version = tag.replace(/^v/, "").split("-")[0];
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const lines = changelog.split(/\r?\n/);

const section = (heading) => {
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## \[/.test(lines[i])) break;
    body.push(lines[i]);
  }
  const text = body.join("\n").trim();
  return text || null;
};

let body = section(new RegExp(`^## \\[v?${escape(version)}\\]`));
let source = `CHANGELOG ${version}`;
if (!body) {
  body = section(/^## \[Unreleased\]/);
  source = "CHANGELOG Unreleased";
}
if (!body) {
  body = `Release ${tag}.`;
  source = "fallback";
}

const notes = [
  `## ${tag}`,
  "",
  body,
  "",
  "**下载 / Downloads**: Windows 安装包见下方 Assets（MSI / NSIS）。",
].join("\n");

console.log(`release notes from ${source}:\n${notes}`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `body<<RELEASE_NOTES_EOF\n${notes}\nRELEASE_NOTES_EOF\n`
  );
}
