import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const confPath = join(root, "src-tauri", "tauri.conf.json");
const cargoPath = join(root, "src-tauri", "Cargo.toml");
const packagePath = join(root, "package.json");

const originals = {
  conf: readFileSync(confPath, "utf8"),
  cargo: readFileSync(cargoPath, "utf8"),
  package: readFileSync(packagePath, "utf8"),
};

function baseVersion(version) {
  const match = /^(\d+\.\d+\.\d+)/.exec(version);
  if (!match) throw new Error(`无法从版本号取出基线：${version}`);
  return match[1];
}

/** `0.3.1-rc.5`. The counter lives in `local-version.local` and resets when the base changes. */
function localVersion(base) {
  const path = join(root, "local-version.local");
  let rc = 1;
  try {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (saved.base === base && Number.isInteger(saved.rc) && saved.rc >= 1) rc = saved.rc + 1;
  } catch {
    /* first local build for this base */
  }
  writeFileSync(path, `${JSON.stringify({ base, rc }, null, 2)}\n`);
  return `${base}-rc.${rc}`;
}

function restore() {
  writeFileSync(confPath, originals.conf);
  writeFileSync(cargoPath, originals.cargo);
  writeFileSync(packagePath, originals.package);
}

const base = baseVersion(JSON.parse(originals.conf).version);
const version = localVersion(base);
let exitCode;
try {
  const conf = JSON.parse(originals.conf);
  conf.version = version;
  writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`);
  writeFileSync(
    cargoPath,
    originals.cargo.replace(/^version = "[^"]*"/m, `version = "${version}"`)
  );
  const manifest = JSON.parse(originals.package);
  manifest.version = version;
  writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`local version ${version}`);
  const result = spawnSync("pnpm", ["exec", "tauri", "build", "--bundles", "nsis"], {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, CI: "true" },
  });
  exitCode = result.status ?? 1;
} finally {
  restore();
}

process.exit(exitCode ?? 1);
