# 6byte

> 跨平台、极轻、AI 原生的文本工作台。打开 `md` / `txt` / `log` 就能用，数据留在本机。

[![CI](https://github.com/wufangqi/6byte/actions/workflows/ci.yml/badge.svg)](https://github.com/wufangqi/6byte/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/wufangqi/6byte?label=release)](https://github.com/wufangqi/6byte/releases/latest)
[![License](https://img.shields.io/github/license/wufangqi/6byte)](./LICENSE)

**中文** · [English](./README.en.md)

**当前阶段：M0–M2 已交付；M3（模型服务、编辑框内改写、自动补全、txt 自动换行、标题栏右上角入口、UI 统一）已随 v0.1.7 发布**

路线图与技术选型：[技术选型与路线图.md](./技术选型与路线图.md) ·
问题盘点：[docs/项目梳理.md](./docs/项目梳理.md) ·
待办与进度：[docs/待办清单.md](./docs/待办清单.md) ·
UI 规范：[docs/ui-guidelines.md](./docs/ui-guidelines.md) ·
性能实测：[docs/perf.md](./docs/perf.md) ·
发布验收：[docs/release-checklist.md](./docs/release-checklist.md) ·
变更记录：[CHANGELOG.md](./CHANGELOG.md)

---

## 界面预览

| 欢迎页 | 编辑器 + Markdown 分屏预览 |
|---|---|
| ![欢迎页](./docs/assets/welcome.png) | ![编辑器与分屏预览](./docs/assets/editor-preview.png) |

| 跨文件搜索 | 大文件只读预览 |
|---|---|
| ![跨文件搜索](./docs/assets/grep.png) | ![大文件只读预览](./docs/assets/large-file.png) |

> 截图由 `scripts/capture-screenshots.ps1` 通过 WebView2 DevTools 协议从安装版自动抓取（1280×800）。

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面运行时 | Tauri 2（系统 WebView，安装包约 4–5 MB，含 KaTeX/Mermaid 按需资源） |
| 前端 | React 19 + TypeScript + Vite 6 |
| 编辑器 | CodeMirror 6（多选、折叠、搜索面板、Markdown 高亮） |
| Markdown 预览 | markdown-it 15（分屏 + 滚动同步）；KaTeX / Mermaid 按需加载 |
| 核心层（Rust） | 编码检测与回写（`encoding_rs` + `chardetng`）、原子保存、文件 stat、大文件行索引与区间读取 |
| 状态 | zustand 5 |
| 质量 | ESLint 10 + Prettier + Vitest + GitHub Actions（三平台） |

## 安装（终端用户）

从 [Releases v0.1.7](https://github.com/wufangqi/6byte/releases/tag/v0.1.7) 下载：

- `6byte_0.1.7_x64-setup.exe`（NSIS，单用户安装，无需管理员权限，推荐）
- `6byte_0.1.7_x64_en-US.msi`（企业部署 / 静默安装）

卸载走「设置 → 应用」或安装目录下的 `uninstall.exe`。

## 开发

```bash
# 依赖：Node 20+ / pnpm 11 / Rust stable + 平台构建工具（Windows 为 MSVC）
pnpm install

pnpm tauri dev        # 桌面版（推荐）
pnpm dev              # 只调 UI（浏览器预览，无文件读写能力）
pnpm tauri build      # 出安装包 → src-tauri/target/release/bundle/
```

提交前自检：

```bash
pnpm exec tsc --noEmit && pnpm lint && pnpm format:check && pnpm test && pnpm build
cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings && cargo test --lib
```

端到端冒烟（需要安装版 + WebView2 远程调试端口，覆盖 UI 路径）：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
Start-Process "$env:LOCALAPPDATA\6byte\6byte.exe"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e-smoke.ps1
```

一键提 PR（本地检查 → 提交 → push → 开 PR → 等 6 项检查 → squash 合并）：

```powershell
scripts\ship.ps1 -Title "feat: ..." -Body "说明"
```

发布：推送 `vX.Y.Z` tag 会触发 `Release` workflow（`.github/workflows/release.yml`），
在 Windows 上构建 MSI/NSIS 并附到 GitHub Release。tag 推送默认创建 **draft**，核对资产后发布；
`workflow_dispatch` 传 `publish: true` 可直接发布。workflow 会校验 tag 与三处版本号一致，
Release Notes 从 `CHANGELOG.md` 对应章节抽取。

> **Windows 注意**：`pnpm-workspace.yaml` 设置了 `nodeLinker: hoisted`。原因是当前 Windows
> 环境下 Node 的 ESM 解析不穿透 pnpm 的 junction 链接，默认 isolated 布局会让 vite 报
> `Cannot find package 'picomatch'`。改用扁平 node_modules 可规避，代价是依赖隔离性弱一些。

## 已验证

| 检查项 | 命令 | 结果 |
|---|---|---|
| 前端类型检查 | `pnpm exec tsc --noEmit` | ✅ 0 error |
| Lint / 格式化 | `pnpm lint`、`pnpm format:check` | ✅ 通过 |
| 前端单测 | `pnpm test` | ✅ 147/147（store、格式化、大文件窗口几何、markdown 渲染/图片路径、大纲、滚动同步、HTML 导出、分屏比例、主题、图表、i18n、标题栏与预览状态、每标签撤销历史、模型目录不含密钥、选区流式、编辑框内高亮接受/取消、路径文件名） |
| 前端打包 | `pnpm build` | ✅ 主包 996 KB / gzip 338 KB（+ 按需 Shiki/KaTeX/Mermaid chunk，dist 总计 8.57 MB） |
| Rust 单测 | `cargo test --lib` | ✅ 75 passed / 0 failed（+4 ignored 性能探针；编码、文件命令、大文件索引/区间、监听、grep、图片落盘、`list_text_files`、fixture 语料、OpenAI 兼容流式、钥匙串与连通性探测、编辑路径超时与重试、思考内容；共 79 用例） |
| Rust 格式 | `cargo fmt --all -- --check` | ✅ 通过 |
| Rust Clippy | `cargo clippy --all-targets -- -D warnings` | ✅ 通过（本机需 `RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc`，见 docs/perf.md） |
| 安装包 | `pnpm tauri build` | ✅ MSI 5.70 MB / NSIS 4.88 MB（含 KaTeX/Mermaid 资源与模型客户端） |
| 安装与启动 | 安装版（NSIS 静默装） | ✅ 冷启动中位 0.094 s，关窗拦截生效 |
| 端到端冒烟 | `scripts/e2e-smoke.ps1` | ✅ 91/91（22 步；第 0 步清空会话/主题/语言；大文件、混合换行、会话恢复、外部修改、脏冲突、grep、查找替换、Markdown 预览/导出/大纲、图片粘贴、Shiki、分屏拖拽、最近删除、标题栏菜单、主题切换与持久化、按文件预览、Mermaid/KaTeX、中英切换与重载持久化、撤销历史跨标签/预览） |
| 三平台 CI | GitHub Actions | ✅ `CI` 全绿（Windows / macOS / Ubuntu × 前端 + Rust） |
| 发布自动化 | tag 推送 `Release` workflow | ✅ v0.1.7 实跑通过（run 40111156255）：Windows 构建 MSI/NSIS → draft Release → 核对后发布；`check-version` 校验版本号 |

## 性能（诚实数据，详见 [docs/perf.md](./docs/perf.md)）

| 指标 | 预算 | 实测 |
|---|---|---|
| 冷启动 | ≤ 1.5 s | **0.094 s**（中位，20 次，Win11 / i5-1335U） |
| 10 MB 打开（Rust 读 + 解码） | ≤ 500 ms | **14.1 ms**（CodeMirror 端到端未测） |
| 100 MB 行索引 | ≤ 150 ms | **64.6 ms**（154 万行，首次建索引） |
| 跨文件 grep（1000 个文件） | ≤ 2 s | **64.5 ms** |
| 35 MB 打开到首屏（只读预览） | ≤ 1 s | **458 ms**（含应用启动，CDP 实测） |
| 输入延迟 P95 | ≤ 16 ms | **5.6 ms**（1000 行 L0）；L1：10 MB **3.0 ms**、19 MB **2.7 ms** |
| 3 文件内存 | ≤ 260 MB（空载基线 ≤230 MB） | ⚠️ 空载私有 **220 MB**（WebView2 基线）；关 GPU 可降至 159 MB（见 perf.md） |
| 安装包 | ≤ 20 MB | ✅ 4.88 MB（NSIS，当前构建） |

## 已实现

- [x] 打开 / 保存 / 另存为（Ctrl+O / Ctrl+S / Ctrl+Shift+S）、新建（Ctrl+N）、关闭（Ctrl+W）
- [x] 多标签、脏标记、中键关闭、拖拽文件到窗口打开
- [x] 会话恢复与最近文件（12 个，支持单项删除与清空）
- [x] 编码检测：UTF-8 / UTF-8 BOM / UTF-16LE / UTF-16BE / chardetng 猜测（含 GBK）
- [x] **原编码 / BOM / 换行符回写**，有损解码文件保存前二次确认
- [x] 原子保存（临时文件 + rename，失败降级）
- [x] 外部修改检测（stat 比对，冲突三选一）
- [x] 大文件分级（T12）：≤5 MB 全功能；5–20 MB 关闭折叠/语法装饰；20–100 MB 只读虚拟滚动预览
      （Rust 行偏移索引 + 区间读取，单次 400 行，打开 35 MB 到首屏 458 ms）；>100 MB 通过 memmap 只读预览（上限 512 MB，120 MB 建索引 93 ms）
- [x] 二进制防护（64 KB NUL 探测，UTF-16 BOM 豁免）
- [x] 混合换行识别：状态栏「混合换行」徽标，保存前确认后统一为主导换行符
- [x] 跨文件搜索（Ctrl+Shift+F）：Rust `regex` 扫目录树，跳过二进制/依赖目录，结果点击跳转到对应行
- [x] 外部修改监听（notify，按父目录监听）：无未保存修改时静默重载，有修改时三选一「保留我的修改 / 加载磁盘版本 / 稍后处理」
- [x] 会话恢复时失效文件自动跳过并一次性提示（随后从会话中剔除）
- [x] 脏标签 / 关窗拦截（保存 / 不保存 / 取消）
- [x] CodeMirror 6 查找面板（Ctrl+F，正则与捕获组替换，面板已中文化）
- [x] Markdown 分屏预览（Ctrl+Shift+M 或状态栏「预览」）：markdown-it 渲染、120 ms 防抖实时更新、双向比例滚动同步、外链拦截提示；**分隔条可拖拽调整左右宽度**（双击恢复 50/50，方向键微调）
- [x] 导出 HTML：预览工具栏一键导出，自包含（内联样式、图片内联为 data URI、无外部依赖），默认写到源文件同目录
- [x] 大纲面板：标题自动锚点 + 「大纲（N）」浮层，点击跳转到预览对应位置
- [x] 图片粘贴：编辑器内粘贴图片自动存到 `assets/` 并插入 Markdown 引用，预览经 data URI 显示
- [x] Mermaid 图表与 KaTeX 公式：预览里按需渲染；图表失败留在代码块，公式无法解析时仍显示原文
- [x] 自定义标题栏：文件菜单（新建 / 新窗口 / 打开文件 / 打开文件夹 / 打开最近 / 保存 / 另存为 / 保存全部）与视图菜单（浅色 / 深色 / 跟随系统），窗口按钮与应用图标
- [x] 主题：浅色 / 深色 / 跟随系统，写入 `localStorage`（`ainative.theme`）；编辑器、预览、Shiki 代码高亮、Mermaid 图表与导出 HTML 都跟随主题
- [x] 按文件预览：每个标签独立记住预览开关，重新打开文件回到编辑模式
- [x] 界面中英双语：菜单、状态栏、搜索、预览与对话框全部双语；视图 → 语言切换，写入 `localStorage`（`ainative.locale`），重启后保持
- [x] 撤销历史按标签保留（M-06）：所有标签共享同一个 `EditorView`，每个标签保留自己的 `EditorState`；切换标签、开关预览不再重置撤销历史，切回时恢复撤销栈、光标与滚动位置
- [x] 模型服务分两级：服务商（地址与 API Key）下再管理模型。密钥按服务商进钥匙串。标题栏右上角「模型服务」
- [x] 选区改写：状态栏「模型」。左边写要求，右边思考过程可收起。正文流式写进当前编辑框并高亮。接受替换原文且不保存文件，取消恢复原文。15 秒无首字则取消；429/5xx 重试 2 次
- [x] 一键动作：模型面板顶部「润色 / 翻译 / 总结」，选中文字后点一下即发送；说明框显示实际要求，接受 / 取消与手动改写一致（一次撤销、不自动保存）
- [x] 自动补全：默认关闭，模型与改写分开配置。停笔约半秒后建议出现在光标后，Tab 接受、Esc 取消，不自动保存。补全、模型、模型服务入口在标题栏右上角
- [x] `.txt` 与未命名笔记自动换行（只改显示，不改文件）；markdown / log / json 仍按原行显示
- [x] 打开文件夹（`list_text_files`，一次最多 40 个文本文件）与新建窗口（空白会话，只有主窗口恢复/保存会话）
- [x] 跨文件搜索面板（Ctrl+Shift+F，正则 + 大小写开关 + 点击跳转）

## 尚未实现（按路线图 M1 → M4）

- [ ] 跨文件 grep 的增量/正则缓存优化（M2 视需要）
- [ ] AI 改写：Ctrl+K 内联 diff 与 Tab 接受（M3）。改写已在编辑框内落地，只差快捷键
- [ ] 便携版、winget、自动更新、右键菜单（M4）

## 目录结构

```
src/                  React 前端
  editor/             CM6 封装、扩展、单视图 + 每标签 EditorState（唯一可 import @codemirror/*）
  features/           标题栏菜单 / 主题 / 标签栏 / 状态栏 / 欢迎页 / 弹窗 / 大文件查看器 / grep / Markdown 预览、导出、大纲、图片粘贴、Mermaid 与 KaTeX
  ipc/                所有 Tauri command 与事件的类型化封装（唯一可 import @tauri-apps/*；含窗口会话归属）
  stores/             zustand 状态
  lib/                纯工具函数
src-tauri/            Rust 核心层
  src/codec.rs        编码检测与回写（含单测）
  src/bigfile.rs      大文件分级、行偏移索引、区间读取（含单测）
  src/watcher.rs      文件监听（notify，父目录监听 + 事件去重，含单测）
  src/grep.rs         跨文件搜索（regex，跳过二进制/依赖目录，含单测）
  src/ai.rs           模型 Provider、OpenAI 兼容流式、取消、连通性探测（含单测）
  src/secrets.rs      API Key 的系统钥匙串（测试用内存替身，不写配置文件）
  src/commands.rs     文件读写、stat、原子保存、open_document、grep_files、watch_file、大文件/二进制防护
  capabilities/       Tauri 权限（最小集）
scripts/
  e2e-smoke.ps1       CDP 驱动的端到端冒烟（22 步：编辑、预览、主题、语言、撤销历史等）
  gen_icons.py        生成应用图标
.github/workflows/    CI（三平台前端检查 + Rust fmt/clippy/test）
docs/                 项目梳理、待办清单、性能实测、发布验收清单
```

## 已知限制

- 预览高亮只覆盖 10 种常用语言，其他语言显示为纯文本。
- 图片粘贴默认存到源文件同目录的 `assets/`；预览/导出通过 Rust 命令读取并内联为 data URI（单张上限 32 MB）。
- 自定义标题栏目前只在 Windows 做过验证，macOS / Linux 的窗口按钮与拖拽区域待适配。
- 导出 HTML 默认写到源文件同目录的同名 `.html`，再次导出会覆盖该文件。
- 脏标记只增不减：撤销回到保存点后仍显示未保存。
- 混合换行文件保存时会统一为主导 EOL（保存前会弹窗确认）。
- 20 MB 以上的文件以只读预览打开（>100 MB 走 memmap，上限 512 MB），暂不支持编辑保存。
- 无自动更新、无便携版（M4）。

## 参与贡献

见 [CONTRIBUTING.md](./CONTRIBUTING.md)（目录约束、测试要求、提交规范、发布流程）。

## 许可证

[MIT](./LICENSE)