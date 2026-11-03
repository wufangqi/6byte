# AGENTS.md

## 核心目标

**人和 AI 共建文件。**

Humans and AI co-author files — not AI writing files for people, and not a chat sidebar that cannot touch the document. Both sides work on the same file: the AI proposes, the human reviews and accepts, and the file is the single source of truth.

## 这条目标意味着什么

- **AI 只提出候选。** 改写、补全、问答转改写都先形成可审阅的候选；用户接受之前，正文一个字节都不变。
- **接受与保存是两件事。** 「接受」只改编辑器缓冲区；是否写盘仍由用户显式保存决定。
- **审阅必须可逆。** 每次接受都能一次撤销；切换文档会放下未接受的候选，并明确告诉用户。
- **上下文只读。** 询问模式只能列目录、搜索、按区间读取、读大纲；不能写文件，读不到隐藏文件、密钥文件和禁读名单里的路径。
- **本机 Agent / MCP 同样只读。** 本地接口只提供当前文档、选区、工作区读取和候选；`POST /v1/candidate` 必须带上读到的修订号与字符范围。范围外打字时候选跟着移动，范围内改过则候选失效。
- **人始终在环里。** 不自动保存、不做跨文件自治写入、不把 AI 变成通用聊天侧栏。
- **诚实优先。** 编码、大文件、平台限制、失败原因都要说清楚；错误文案要能指导下一步。
- **文件优先。** 不引入隐藏的 AI 文档状态；离开仓库后，用户拿到的文件必须仍然完整、可读、可编辑。

## 产品边界

不做 IDE，不做 VS Code / VSCodium 二开，不做 AI 的 VS Code 扩展；不做 WYSIWYG、知识图谱、插件系统、实时协作、通用聊天侧栏、自动跨文件写入；不引入遥测。

## 工程约定

- 技术栈：Tauri 2 + React 19 + TypeScript + Vite 6 + CodeMirror 6 + zustand 5；Rust 后端负责文件、编码、大文件、grep、AI 传输与本机 Agent。
- `master` 受保护；所有改动走 PR。发布/合并脚本见 [`scripts/ship.ps1`](scripts/ship.ps1)。
- `docs/` 在本机保留、不入库（`.gitignore` 忽略）；README、CHANGELOG、CONTRIBUTING 与 AGENTS.md 入库。
- 完成定义：`pnpm exec tsc --noEmit`、`eslint .`、`prettier --check .`、`vitest run`、`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test --lib` 全绿；涉及用户路径时补 E2E。
- 当前验证基线：前端 325/325（56 文件）、Rust 130 + 4 ignored、主 E2E 109/109、AI E2E 6/6。
- 发布流程与验收清单见 [`docs/release-checklist.md`](docs/release-checklist.md)（本机文档）与 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 相关文档

- [`README.md`](README.md) / [`README.zh.md`](README.zh.md)：产品说明与截图
- [`CONTRIBUTING.md`](CONTRIBUTING.md)：开发、测试与提交约定
- [`CHANGELOG.md`](CHANGELOG.md)：版本变更
- `docs/技术选型与路线图.md`、`docs/待办清单.md`：本机维护的路线与进度
