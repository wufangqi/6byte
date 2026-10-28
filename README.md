# 6byte

> A cross-platform, lightweight, AI-native text workbench. Open `md` / `txt` / `log` and start writing — your data stays on your machine.

[![CI](https://github.com/wufangqi/6byte/actions/workflows/ci.yml/badge.svg)](https://github.com/wufangqi/6byte/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/wufangqi/6byte?label=release)](https://github.com/wufangqi/6byte/releases/latest)
[![License](https://img.shields.io/github/license/wufangqi/6byte)](./LICENSE)

[中文](./README.zh.md) · **English**

**Status**: v0.2.0 (2026-10-27) is out: M0–M3, AI review-first rewriting, workspace file tree, Markdown-first preview and export parity. Installers cover Windows, Linux and macOS.

> The app UI is bilingual (switch under **View → Language**). The detailed docs under `docs/` are written in Chinese.

![Welcome](./docs/assets/welcome.png)
![Editor with Markdown split preview](./docs/assets/editor-preview.png)

## What it does

- **Writing**: tabs, session restore, recent files, per-tab undo history, drag & drop, middle-click close, rename from a tab's context menu or `F2`.
- **Markdown**: opens rendered by default; `<>` (or `Ctrl+Shift+M`) reveals the source. Split preview, HTML export, outline, Mermaid / KaTeX, Shiki highlighting, image paste, draggable divider; Mermaid diagrams zoom (25–300%), pan and reset in the preview.
- **Large files**: ≤5 MB full editing; 5–20 MB reduced decorations; 20–100 MB read-only virtual scrolling; >100 MB read-only memmap (512 MB cap).
- **Encoding & data safety**: UTF-8 / BOM / UTF-16 / GBK detection, write-back with the original encoding and line endings, confirmation before overwriting lossily decoded files, atomic save, external-change detection with a three-way conflict dialog.
- **File tree**: open one folder and browse one level at a time; click a file to open it. Hidden names, dependency folders and symlinks stay out of the tree. Closing the folder leaves open tabs alone. Toggle the panel from the status bar or with `Ctrl+Shift+E`; the collapsed state survives restarts.
- **Search**: `Ctrl+F` find & replace (regex, capture groups), `Ctrl+Shift+F` cross-file grep (workspace root when a folder is open, otherwise the active file's directory; skips binaries and dependency folders).
- **AI (v0.2.0)**: model services (providers → models, API keys in the OS keychain); select text and use `Ctrl+K` to rewrite it, then **Tab** accepts or **Esc** cancels. Candidates are reviewed inline before touching the document, the AI panel is a resizable right dock with a status-bar toggle, and a title-bar toggle controls the selection entry. One-click Polish / Translate / Summarize, follow-up prompts, on-device conversation history, the workspace command palette (`Ctrl+P`), `@` references, read-only ask mode and autocomplete (off by default) are also available. A selection in the Markdown preview can be rewritten too.
- **Interface**: Chinese / English, light / dark / follow system, custom title bar; `.txt` and untitled notes wrap visually. Settings (`Ctrl+,`) is a tab with General / Models / Providers / Conversation & limits / Access / Usage sections; the Help menu has About (version / platform / Tauri) and the keyboard shortcut reference.
- **Light**: Tauri 2 with the system WebView, ~5 MB installers, ~0.1 s cold start.

## Install

Download from [Releases](https://github.com/wufangqi/6byte/releases/latest):

- `6byte_0.2.0_x64-setup.exe` — NSIS, per-user install, no admin rights (recommended)
- `6byte_0.2.0_x64_en-US.msi` — MSI, for enterprise / silent install

**Linux**

- `6byte_0.2.0_amd64.deb` — Debian / Ubuntu: `sudo apt install ./6byte_0.2.0_amd64.deb`
- `6byte_0.2.0_amd64.AppImage` — portable: `chmod +x 6byte_0.2.0_amd64.AppImage && ./6byte_0.2.0_amd64.AppImage`

Needs WebKitGTK 4.1 (`libwebkit2gtk-4.1-0` on Ubuntu 22.04+ / Debian 12+).

**macOS**

- `6byte_0.2.0_universal.dmg` — universal (Apple Silicon + Intel). The build is unsigned and not notarized: right-click → **Open** the first time, or run `xattr -dr com.apple.quarantine /Applications/6byte.app`.

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

Frontend unit tests **241**, Rust **107** (+4 ignored). The latest installed-build E2E is **107/107 across 24 steps** (2026-10-27, includes the file-tree steps). A freshly rebuilt release binary passed **6/6** isolated local-SSE-mock AI E2E checks for rewrite review, native read-only tool calling, and answer navigation/insertion. CI covers Windows / macOS / Ubuntu. Performance numbers are in [docs/perf.md](./docs/perf.md).

## Known limitations

- 20–100 MB files are read-only; >100 MB opens as a read-only memmap preview (≤512 MB). Neither can be edited or saved.
- The dirty flag only grows: undoing back to the saved state still shows unsaved.
- Files with mixed line endings are normalized to the dominant EOL on save (confirmed first).
- AI needs your own OpenAI-compatible endpoint and API key; the key goes to the OS keychain, never a config file.
- No auto-update, no portable build, no Explorer context menu (M4).
- The file tree is read-only: no create or delete, no Git status, no watch of the whole tree (open files are still watched), and symlinks are skipped. A single folder lists at most 2000 entries. Rename a file from its tab context menu or with `F2`.
- The custom title bar has only been verified on Windows. Linux and macOS installers are built by CI; they have not been smoke-tested on real machines yet.

## Roadmap

Next: long-Markdown preview benchmarks (T71), a shared DocumentModel (T72), and the remaining AI review/lifecycle polish (T73–T76). v0.2.0 ships the AI trust loop, workspace context, Markdown-first preview/export parity, file rename, diagram zoom and multi-platform installers. Details in [docs/待办清单.md](./docs/待办清单.md).

## Docs

- [Roadmap & design notes](./技术选型与路线图.md) (Chinese)
- [Backlog & progress](./docs/待办清单.md) · [Changelog](./CHANGELOG.md)
- [Performance](./docs/perf.md) · [Release checklist](./docs/release-checklist.md)
- [UI guidelines](./docs/ui-guidelines.md) · [Project review](./docs/项目梳理.md) · [Workspace tree PRD](./docs/PRD-工作区文件树.md)
- [Contributing](./CONTRIBUTING.md)

## License

[MIT](./LICENSE)
