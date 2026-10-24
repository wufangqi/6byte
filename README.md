# 6byte

> A cross-platform, lightweight, AI-native text workbench. Open `md` / `txt` / `log` and start writing — your data stays on your machine.

[![CI](https://github.com/wufangqi/6byte/actions/workflows/ci.yml/badge.svg)](https://github.com/wufangqi/6byte/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/wufangqi/6byte?label=release)](https://github.com/wufangqi/6byte/releases/latest)
[![License](https://img.shields.io/github/license/wufangqi/6byte)](./LICENSE)

[中文](./README.zh.md) · **English**

**Status**: v0.1.7 (2026-10-25) is out with M0–M3. One-click actions and `Ctrl+K` / Tab accept are merged into `master` and will ship in the next version.

> The app UI is bilingual (switch under **View → Language**). The detailed docs under `docs/` are written in Chinese.

![Welcome](./docs/assets/welcome.png)
![Editor with Markdown split preview](./docs/assets/editor-preview.png)

## What it does

- **Writing**: tabs, session restore, recent files, per-tab undo history, drag & drop, middle-click close.
- **Markdown**: split preview, HTML export, outline, Mermaid / KaTeX, Shiki highlighting, image paste, draggable divider.
- **Large files**: ≤5 MB full editing; 5–20 MB reduced decorations; 20–100 MB read-only virtual scrolling; >100 MB read-only memmap (512 MB cap).
- **Encoding & data safety**: UTF-8 / BOM / UTF-16 / GBK detection, write-back with the original encoding and line endings, confirmation before overwriting lossily decoded files, atomic save, external-change detection with a three-way conflict dialog.
- **Search**: `Ctrl+F` find & replace (regex, capture groups), `Ctrl+Shift+F` cross-file grep (skips binaries and dependency folders).
- **AI**: model services (providers → models, API keys in the OS keychain); `Ctrl+K` or the title-bar **Model** chip rewrites the selection, **Tab** accepts, **Esc** cancels; one-click Polish / Translate / Summarize; autocomplete (off by default).
- **Interface**: Chinese / English, light / dark / follow system, custom title bar; `.txt` and untitled notes wrap visually.
- **Light**: Tauri 2 with the system WebView, ~5 MB installers, ~0.1 s cold start.

## Install

Download from [Releases](https://github.com/wufangqi/6byte/releases/latest):

- `6byte_0.1.7_x64-setup.exe` — NSIS, per-user install, no admin rights (recommended)
- `6byte_0.1.7_x64_en-US.msi` — MSI, for enterprise / silent install

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

`tsc` / `eslint` / `prettier` / `cargo fmt` / `clippy` are green; frontend unit tests **147**, Rust **75** (+4 ignored), installed-build E2E **91/91 across 22 steps**; CI covers Windows / macOS / Ubuntu. Performance numbers are in [docs/perf.md](./docs/perf.md).

## Known limitations

- 20–100 MB files are read-only; >100 MB opens as a read-only memmap preview (≤512 MB). Neither can be edited or saved.
- The dirty flag only grows: undoing back to the saved state still shows unsaved.
- Files with mixed line endings are normalized to the dominant EOL on save (confirmed first).
- AI needs your own OpenAI-compatible endpoint and API key; the key goes to the OS keychain, never a config file.
- No auto-update, no portable build, no Explorer context menu (M4).
- The custom title bar has only been verified on Windows.

## Roadmap

Next: workspace file tree ([T54 / PRD](./docs/PRD-工作区文件树.md), replacing today's "open folder" batch-open behaviour), then M4 distribution. Details in [docs/待办清单.md](./docs/待办清单.md).

## Docs

- [Roadmap & design notes](./技术选型与路线图.md) (Chinese)
- [Backlog & progress](./docs/待办清单.md) · [Changelog](./CHANGELOG.md)
- [Performance](./docs/perf.md) · [Release checklist](./docs/release-checklist.md)
- [UI guidelines](./docs/ui-guidelines.md) · [Project review](./docs/项目梳理.md) · [Workspace tree PRD](./docs/PRD-工作区文件树.md)
- [Contributing](./CONTRIBUTING.md)

## License

[MIT](./LICENSE)
