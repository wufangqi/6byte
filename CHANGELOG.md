# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

> 计划随 **v0.1.6** 发布；当前代码版本号仍为 0.1.5。

### Added

- Markdown 预览支持 **Mermaid** 图表和 **KaTeX** 公式（`$…$` / `$$…$$`），两者都按需加载。
  图表无法解析时保留代码块，公式无法解析时仍显示原文。
- 自定义标题栏：应用图标、文件菜单、视图菜单，以及最小化 / 最大化 / 关闭。
- 外观：浅色、深色、跟随系统。未选择时保持深色。编辑器、代码高亮、图表和导出 HTML 跟随当前外观。
- 文件菜单：新建、新建窗口、打开文件、打开文件夹、最近打开、保存、另存为、全部保存。
  新建窗口从欢迎页开始，不把当前窗口的文件再打开一份。
- 预览开关按文件记住。同一窗口里每个文件各自独立；重新打开文件时回到编辑模式。

### Fixed

- 本地图片路径含中文或空格时，预览可以显示。

## [0.1.5] - 2026-10-22

### Added

- 大文件只读预览扩展到 **>100 MB**：L3 文件通过 `memmap2` 内存映射读取区间（上限 512 MB），
  实测 120 MB / 185 万行建索引 93.1 ms、400 行区间读取 0.48 ms。
- 预览与导出 HTML 的本地图片改为 **内联 data URI**：新增 `read_binary_base64` 命令，
  导出的 HTML 单文件即可换机器查看（M-03）。
- 「另存为」命中已打开路径时提示并切换到已有标签，不再产生重复标签（M-05）。

### Changed

- 移除 `assetProtocol` 与 `protocol-asset` 特性：图片读取改走自有命令（限 32 MB），
  不再需要把本地文件暴露给 webview 的 asset 协议（M-04 安全收紧）。

## [0.1.4] - 2026-10-22

### Added

- 「最近打开」支持**单项删除**（悬停条目显示 ×）与一键**清空**；删除后立即写回 `localStorage`。

### Fixed

- 欢迎页大标题仍显示旧名「AI 原生文本编辑器」，改为 **6byte**。

## [0.1.3] - 2026-10-22

### Added

- Markdown 分屏预览支持**拖拽调整左右宽度**：拖动中间分隔条在 20%–85% 之间调整，双击恢复 50/50，
  分隔条获得焦点后可用 ←/→ 微调 ±3%；比例持久化到 `localStorage`（`ainative.splitPercent`）。

## [0.1.2] - 2026-10-22

### Changed

- 产品更名为 **6byte**：安装目录 `%LOCALAPPDATA%\6byte`、窗口标题、界面品牌与安装包名
  （`6byte_0.1.2_x64-setup.exe` / `.msi`）全部更新；E2E / 截图脚本与文档路径同步。
- bundle identifier 保持 `dev.aneditor.app` 不变，因此 **0.1.1 的会话与最近文件会继承**。

## [0.1.1] - 2026-10-22

### Changed

- 产品更名为 **aneditor**：可执行文件 `aneditor.exe`、安装目录 `%LOCALAPPDATA%\aneditor`、窗口标题、
  安装包名（`aneditor_0.1.1_x64-setup.exe` / `.msi`）与 bundle identifier（`dev.aneditor.app`）全部更新，
  E2E / 截图脚本与文档中的路径同步修改。
- 注意：bundle identifier 变化后，v0.1.0 的会话与最近文件不会继承；安装新版后旧版本可手动卸载。

## [0.1.0] - 2026-10-21

### Added

- M0 骨架：Tauri 2 + React 19 + TypeScript + CodeMirror 6 + zustand。
- 打开 / 保存 / 另存为，多标签与脏标记，原生拖拽打开，会话恢复与最近文件。
- 编码检测（UTF-8 / UTF-8 BOM / UTF-16LE / UTF-16BE / chardetng 猜测），
  保存时按原编码、原 BOM、原换行符回写。
- 原子保存（临时文件 + rename，失败时降级为直接写入）。
- 有损解码文件在保存前的二次确认（`allowLossy`），拒绝静默覆盖原始字节。
- 外部修改检测：保存前比对 mtime/size，冲突时提供「取消 / 加载磁盘版本 / 仍然覆盖」。
- 大文件分级加载（T12）：≤5 MB 全功能编辑；5–20 MB 关闭折叠/语法/选区装饰；20–100 MB 进入
  只读虚拟滚动预览（Rust 行偏移索引 + `read_range` 区间读取，单次 400 行）；>100 MB 明确拒绝并提示。
- 二进制防护：前 64 KB NUL 探测（UTF-16 BOM 豁免）。
- 脏标签关闭与窗口关闭拦截（保存 / 不保存 / 取消）。
- 混合换行识别：状态栏「混合换行」徽标，保存前确认后统一为主导换行符。
- 查找替换面板中文化（查找 / 替换 / 下一个 / 上一个 / 全部替换 / 区分大小写 / 正则 / 全词匹配）。
- Markdown 分屏预览（M2 MVP）：`markdown-it` 渲染（禁原始 HTML、自动链接、fence 语言类）、
  120 ms 防抖实时更新、编辑器 ↔ 预览双向比例滚动同步、`#anchor` 页内跳转、外链点击拦截提示；
  Ctrl+Shift+M 或状态栏「预览」按钮切换，开关持久化。
- Markdown 代码高亮：Shiki 4 高亮 10 种常用语言（js/ts/json/html/css/rust/python/bash/markdown/yaml），
  按需加载（首次出现代码块时才加载 wasm 与 grammar），不支持的语言回退纯文本。
- Markdown 图片粘贴：在编辑器内粘贴图片会写入源文件同目录的 `assets/`（文件名净化、20 MB 上限、原子写），
  光标处插入 `![图片](assets/xxx.png)`，预览经 Tauri asset 协议显示本地图片。
- Markdown 大纲：标题自动生成稳定锚点（重名自动去重），预览工具栏「大纲（N）」浮层按层级列出，
  点击跳转到预览对应位置（悬停显示源行号）。
- Markdown 导出 HTML：预览工具栏一键导出，自包含文档（内联深色样式、标题转义、正文不执行原始 HTML），
  默认写到源文件同目录；无路径的新标签走保存对话框。成功时蓝色提示 4 s 自动消失。
- 跨文件搜索：Rust `regex` 递归扫描目录（跳过 `.git`/`node_modules`/`target`/`dist` 与二进制文件），
  结果面板支持点击跳转到对应行；Ctrl+Shift+F 打开。
- 外部修改监听（`notify`，按父目录监听以兼容原子保存）：无未保存修改时静默重载；有修改时三选一
  「保留我的修改 / 加载磁盘版本 / 稍后处理」；文件被删除时给出明确提示。
- 会话恢复时失效文件自动跳过并一次性提示（随后从会话中剔除）。
- 编码语料 fixtures（UTF-8 / BOM / GBK / UTF-16LE / CR-only / 混合换行 / GB18030 四字节 / 二进制）。
- 状态栏：路径、编码、EOL、行数、字符数、大小、脏标记、只读预览、有损告警。

### Changed

- 编辑器热路径改为「CodeMirror 为真源」：按键只更新 O(1) 统计，不再整篇复制进 store；
  保存时读取实时缓冲区，标签切换时带版本守卫回写快照。
- 会话与最近文件持久化分别改为 500 ms 防抖与「引用变化才写盘」。
- 拖拽订阅与窗口关闭统一封装进 `src/ipc/api.ts`，`App.tsx` 不再直接依赖 `@tauri-apps`。

### Fixed

- 修复磁盘重载后，旧 `EditorView` 卸载时的 flush 覆盖新缓冲区的竞态。

### Tooling

- 新增 ESLint 10（flat config）、Prettier、Vitest；前端单测 67 例、Rust 单测 52 个用例（49 通过 + 3 个 ignored 性能探针）。
- 新增 GitHub Actions CI（三平台：前端检查 + Rust fmt/clippy/test）。
- 新增 `scripts/e2e-smoke.ps1`：通过 WebView2 DevTools 协议驱动安装版，覆盖单元测试到不了的 12 条路径
  （大文件预览 / 混合换行 / 会话失效 / 外部修改重载 / 脏标签冲突三选一 / 跨文件搜索跳转 / 查找替换 /
  Markdown 分屏预览 / 导出 HTML / 大纲跳转 / 图片粘贴 / Shiki 高亮），共 48 条断言。