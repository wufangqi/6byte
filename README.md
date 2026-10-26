# 6byte

> A cross-platform, lightweight, AI-native text workbench. Open `md` / `txt` / `log` and start writing — your data stays on your machine.

[![CI](https://github.com/wufangqi/6byte/actions/workflows/ci.yml/badge.svg)](https://github.com/wufangqi/6byte/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/wufangqi/6byte?label=release)](https://github.com/wufangqi/6byte/releases/latest)
[![License](https://img.shields.io/github/license/wufangqi/6byte)](./LICENSE)

[中文](./README.zh.md) · **English**

**Status**: v0.1.8 (2026-10-26) is out with M0–M3, the workspace file tree and Markdown-first preview. Installers are now built for Windows, Linux and macOS.

> The app UI is bilingual (switch under **View → Language**). The detailed docs under `docs/` are written in Chinese.

![Welcome](./docs/assets/welcome.png)
![Editor with Markdown split preview](./docs/assets/editor-preview.png)

## What it does

- **Writing**: tabs, session restore, recent files, per-tab undo history, drag & drop, middle-click close.
- **Markdown**: opens rendered by default; `<>` (or `Ctrl+Shift+M`) reveals the source. Split preview, HTML export, outline, Mermaid / KaTeX, Shiki highlighting, image paste, draggable divider.
- **Large files**: ≤5 MB full editing; 5–20 MB reduced decorations; 20–100 MB read-only virtual scrolling; >100 MB read-only memmap (512 MB cap).
- **Encoding & data safety**: UTF-8 / BOM / UTF-16 / GBK detection, write-back with the original encoding and line endings, confirmation before overwriting lossily decoded files, atomic save, external-change detection with a three-way conflict dialog.
- **File tree**: open one folder and browse one level at a time; click a file to open it. Hidden names, dependency folders and symlinks stay out of the tree. Closing the folder leaves open tabs alone. Toggle the panel from the status bar or with `Ctrl+Shift+E`; the collapsed state survives restarts.
- **Search**: `Ctrl+F` find & replace (regex, capture groups), `Ctrl+Shift+F` cross-file grep (workspace root when a folder is open, otherwise the active file's directory; skips binaries and dependency folders).
- **AI**: model services (providers → models, API keys in the OS keychain); `Ctrl+K` or the title-bar **Model** chip proposes a rewrite beside the selection — the document stays unchanged until **Tab** accepts, and saving or discarding drops the proposal; each reply shows prompt / completion tokens; one-click Polish / Translate / Summarize; `Ctrl+P` opens a command palette for workspace files, recent files and headings; `@` references and a read-only ask mode look things up in the workspace without writing; autocomplete (off by default).
- **Interface**: Chinese / English, light / dark / follow system, custom title bar; `.txt` and untitled notes wrap visually.
- **Light**: Tauri 2 with the system WebView, ~5 MB installers, ~0.1 s cold start.

## Install

Download from [Releases](https://github.com/wufangqi/6byte/releases/latest):

- `6byte_0.1.8_x64-setup.exe` — NSIS, per-user install, no admin rights (recommended)
- `6byte_0.1.8_x64_en-US.msi` — MSI, for enterprise / silent install

**Linux**

- `6byte_0.1.8_amd64.deb` — Debian / Ubuntu: `sudo apt install ./6byte_0.1.8_amd64.deb`
- `6byte_0.1.8_amd64.AppImage` — portable: `chmod +x 6byte_0.1.8_amd64.AppImage && ./6byte_0.1.8_amd64.AppImage`

Needs WebKitGTK 4.1 (`libwebkit2gtk-4.1-0` on Ubuntu 22.04+ / Debian 12+).

**macOS**

- `6byte_0.1.8_universal.dmg` — universal (Apple Silicon + Intel). The build is unsigned and not notarized: right-click → **Open** the first time, or run `xattr -dr com.apple.quarantine /Applications/6byte.app`.

Uninstall via "Settings → Apps" or `uninstall.exe` in the install directory.

## Development

```bash
# Requirements: Node 20+ / pnpm 11 / Rust stable + platform build tools (MSVC on Windows)
pnpm install
pnpm tauri dev      # desktop app
pnpm tauri build    # installers → src-tauri/target/release/bundle/
```

Full commands, directory rules, commit conventions and the release process live in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Verified

Frontend unit tests **156**, Rust **97** (+4 ignored). Installed-build E2E is **107/107 across 24 steps** (2026-10-25, includes the file-tree steps). CI covers Windows / macOS / Ubuntu. Performance numbers are in [docs/perf.md](./docs/perf.md).

## Known limitations

- 20–100 MB files are read-only; >100 MB opens as a read-only memmap preview (≤512 MB). Neither can be edited or saved.
- The dirty flag only grows: undoing back to the saved state still shows unsaved.
- Files with mixed line endings are normalized to the dominant EOL on save (confirmed first).
- AI needs your own OpenAI-compatible endpoint and API key; the key goes to the OS keychain, never a config file.
- No auto-update, no portable build, no Explorer context menu (M4).
- The file tree is read-only: no create, rename or delete, no Git status, no watch of the whole tree (open files are still watched), and symlinks are skipped. A single folder lists at most 2000 entries.
- The custom title bar has only been verified on Windows. Linux and macOS installers are built by CI; they have not been smoke-tested on real machines yet.

## Roadmap

Next: the rest of M4 distribution (portable build, package feeds, auto-update, shell integration), then Linux/macOS smoke tests. The workspace file tree, Markdown-first preview and multi-platform installers ship in v0.1.8. Details in [docs/待办清单.md](./docs/待办清单.md).

## Docs

- [Roadmap & design notes](./技术选型与路线图.md) (Chinese)
- [Backlog & progress](./docs/待办清单.md) · [Changelog](./CHANGELOG.md)
- [Performance](./docs/perf.md) · [Release checklist](./docs/release-checklist.md)
- [UI guidelines](./docs/ui-guidelines.md) · [Project review](./docs/项目梳理.md) · [Workspace tree PRD](./docs/PRD-工作区文件树.md)
- [Contributing](./CONTRIBUTING.md)

## License

[MIT](./LICENSE)
