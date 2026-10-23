// Verify that the version in the three manifests matches the release tag.
// Usage: node scripts/check-version.mjs v0.1.7
// A pre-release suffix (v0.2.0-rc1) is allowed; the base version must match.
import { readFileSync } from "node:fs";

const tag = process.argv[2] ?? "";
const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(tag);
if (!match) {
  console.error(`invalid tag "${tag}": expected vX.Y.Z or vX.Y.Z-suffix`);
  process.exit(1);
}
const base = `${match[1]}.${match[2]}.${match[3]}`;

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const pkg = readJson("../package.json");
const conf = readJson("../src-tauri/tauri.conf.json");
const cargo = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];

const manifests = {
  "package.json": pkg.version,
  "src-tauri/tauri.conf.json": conf.version,
  "src-tauri/Cargo.toml": cargoVersion,
};

const problems = Object.entries(manifests)
  .filter(([, version]) => version !== base)
  .map(([file, version]) => `  ${file}: ${version ?? "(missing)"} (expected ${base})`);
if (problems.length > 0) {
  console.error(`tag ${tag} does not match the manifests:\n${problems.join("\n")}`);
  process.exit(1);
}

console.log(`version ok: tag ${tag} -> ${base}`);
