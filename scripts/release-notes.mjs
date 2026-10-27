// Extract the CHANGELOG section for a release tag. Writes the notes to an
// optional file argument (used by the draft-release job) and exposes them as a
// step output (`body`) for other consumers.
// Usage: node scripts/release-notes.mjs v0.1.8 [notes.md]
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const tag = process.argv[2] ?? "";
const releaseName = tag.replace(/^v/, "");
const version = releaseName.split("-")[0];
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

const changelogVersions = [...new Set([releaseName, version])];
let body = null;
let changelogVersion = null;
for (const candidate of changelogVersions) {
  body = section(new RegExp(`^## \\[v?${escape(candidate)}\\]`));
  if (body) {
    changelogVersion = candidate;
    break;
  }
}
if (!body) {
  console.error(
    `CHANGELOG.md has no non-empty [${changelogVersions.join("] or [")}] section for ${tag}; archive [Unreleased] before releasing.`
  );
  process.exit(1);
}

const notes = [
  `## ${tag}`,
  "",
  body,
  "",
  "**下载 / Downloads**: 见下方 Assets —— Windows（NSIS / MSI）、Linux（deb / AppImage）、macOS（universal DMG，未签名）。",
].join("\n");

const notesFile = process.argv[3];
if (notesFile) {
  writeFileSync(notesFile, `${notes}\n`, "utf8");
}

console.log(`release notes from CHANGELOG ${changelogVersion}:\n${notes}`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `body<<RELEASE_NOTES_EOF\n${notes}\nRELEASE_NOTES_EOF\n`
  );
}
