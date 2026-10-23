# 贡献指南

## 环境要求

| 工具 | 版本 |
|---|---|
| Node.js | ≥ 20（推荐 22/24） |
| pnpm | 11.x（`packageManager` 已固定） |
| Rust | stable（`rust-toolchain` 未固定；1.77.2 为最低） |
| 系统 | Windows 10/11（MSVC 构建工具）、macOS、Linux（webkit2gtk 依赖） |

```bash
pnpm install
pnpm tauri dev        # 桌面端（推荐）
pnpm dev              # 仅浏览器预览，无文件读写
```

> Windows 下 `pnpm-workspace.yaml` 固定了 `nodeLinker: hoisted`，这是绕开 pnpm junction
> 与 Node ESM 解析问题的环境补丁，不要改回 `isolated`。

## 常用命令

```bash
pnpm exec tsc --noEmit     # 类型检查
pnpm lint                  # ESLint
pnpm format                # Prettier 写入
pnpm format:check          # Prettier 校验
pnpm test                  # Vitest（前端）
pnpm build                 # 类型检查 + vite 打包
pnpm tauri build           # 打包安装包（MSI / NSIS）

cd src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --lib
```

端到端冒烟（需要安装版；用 WebView2 远程调试协议驱动真实 UI）：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
Start-Process "$env:LOCALAPPDATA\6byte\6byte.exe"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e-smoke.ps1
```

覆盖内容（22 步 / 91 条断言，第 0 步先清空会话）：大文件只读预览（首屏 + 滚动重取）、混合换行徽标、会话恢复时失效文件的
一次性提示与清理、外部修改后干净标签静默重载、脏标签外部修改的三选一冲突弹窗、Ctrl+Shift+F 跨文件搜索
并点击跳转、Ctrl+F 查找替换（面板中文化、命中高亮、全部替换后变脏）、Ctrl+Shift+M Markdown 分屏预览
（渲染 h1/粗体/代码块 + 输入后预览实时更新）、预览导出 HTML（成功横幅 + 目标文件内容）、大纲列表
（条目数 + 点击滚动）、图片粘贴（构造 ClipboardEvent → Markdown 片段 + assets/ 落盘 + data URI 图片）、Shiki 高亮（代码块被替换为 `<pre class="shiki">` 且产生语法 token）、分屏分隔条拖拽（拖动变窄 + 双击恢复 50/50）、最近打开删除（删一条 + localStorage 同步）、自定义标题栏（文件/视图菜单、窗口按钮）、主题切换与重载持久化、按文件独立预览、Mermaid/KaTeX 渲染、浅色主题下代码与图表重绘、中英界面切换与重载持久化、撤销历史跨标签/预览保留（CDP 输入 → 切标签 → Ctrl+Z → 开预览 → Ctrl+Z，编辑器不重挂）。

> 注意：该脚本是 PowerShell 5.1 脚本，文件必须保存为 **UTF-8 with BOM**，否则 PS 5.1 会按 ANSI 解析中文
> 字面量导致断言失败。修改后请用 `[IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($true))`
> 重新写入 BOM。

## 目录职责

| 目录 | 职责 | 约束 |
|---|---|---|
| `src/editor/` | CodeMirror 封装与扩展 | **只有这里可以 import `@codemirror/*`** |
| `src/ipc/` | 所有 Tauri command / 事件 / 对话框的类型化封装 | **只有这里可以 import `@tauri-apps/*`** |
| `src/features/` | 标签栏、状态栏、欢迎页、弹窗 | 只消费 store 与 ipc |
| `src/stores/` | zustand 状态 | 不直接触达 Tauri |
| `src/lib/` | 纯函数工具 | 无副作用 |
| `src-tauri/src/codec.rs` | 编码检测与回写 | 前端只接收 UTF-8 字符串 |
| `src-tauri/src/bigfile.rs` | 大文件分级、行偏移索引、区间读取 | 行索引按 `path + mtime` 缓存，不能整文件进内存 |
| `src-tauri/src/watcher.rs` | 文件监听与外部修改事件 | 监听父目录（不可退回监听单文件，否则原子保存后失效）；事件必须去重 |
| `src-tauri/src/grep.rs` | 跨文件搜索 | 必须跳过二进制/依赖目录并限制结果数，避免一次查询打爆 UI |
| `src-tauri/src/ai.rs` | 模型 Provider 与流式请求 | 取消必须断开连接；流式阶段不写文档；CI 不访问外网 |
| `src-tauri/src/secrets.rs` | API Key 的系统钥匙串 | 密钥不得写入配置文件；命令不得把密钥读回前端 |
| `src-tauri/src/commands.rs` | 文件读写、stat、原子保存、`open_document` / `read_range` / `grep_files` / `watch_file` | 保存必须保持原编码 |

编辑器的活性文本由 `src/editor/registry.ts` 持有；store 中的 `content` 只是快照。

界面改动的约定（颜色、圆角、字号、控件尺寸、焦点态）见 [`docs/ui-guidelines.md`](./docs/ui-guidelines.md)：先查变量与公共类，不要在新组件里写死颜色。
新增涉及“当前缓冲区”的功能时，请用 `getDocText(tabId)` 读取，而不是 `tab.content`。

## 测试

- Rust：编码与文件命令的单测放在对应 `mod tests`；性能探针用 `#[ignore]` 标注。
  `bigfile.rs` 的测试会写真实临时文件（含一个 21 MB 的 L2 用例），耗时约 0.2 s，属于正常范围。
- 前端：`src/**/*.test.ts`（Vitest，node 环境）。涉及 DOM 的测试请先引入 jsdom 再讨论。
- 链路类改动（保存 / 会话 / 大文件 / 编码告警）优先用 `scripts/e2e-smoke.ps1` 的 CDP 通道补一条断言，
  它能在真实安装版里验证 UI 行为，不需要 Playwright/tauri-driver。
- 编码相关改动必须补 fixture（UTF-8 / BOM / GBK / GB18030 / UTF-16 / 混合换行）。

## 提交与 PR

> **`master` 是受保护分支**：禁止 force push 与删除，管理员同样受限，并要求 6 项 CI 检查
> （Windows/macOS/Ubuntu × 前端/Rust）。因为 required checks 会拦截直推，**所有改动都走 PR**：
> 从 `master` 拉分支 → push 分支 → 开 PR → CI 全绿后合并。
>
> 便捷方式：`scripts/ship.ps1 -Title "feat: ..."` 一条命令完成分支 → 本地检查 → 提交 → push → 开 PR → 等 6 项 checks → squash 合并。

- 提交信息使用 Conventional Commits：`feat:` / `fix:` / `refactor:` / `docs:` / `chore:` / `test:`。
- PR 合并前必须通过：`tsc`、`eslint`、`prettier --check`、`vitest`、`cargo fmt --check`、
  `cargo clippy -D warnings`、`cargo test --lib`（CI 会在三平台跑）。
- 涉及保存、编码、关闭流程的改动，请在 PR 描述中写明人工验证步骤。

## 发布

1. 更新 `CHANGELOG.md`（把 `[Unreleased]` 归档为本次版本）与三个版本号
   （`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`），本地验证：
   `node scripts/check-version.mjs vX.Y.Z`。
2. （可选）本地 `pnpm tauri build` + 安装验证；CI 也会在 tag 上重新构建。
3. 打 tag 并推送：`git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`。
   这会触发 `Release` workflow，在 Windows 上构建 MSI/NSIS 并创建 **draft** Release
   （版本号不匹配会直接失败；含 `-` 的 tag 标记为 prerelease）。
4. 核对 draft 资产与 Release Notes，然后发布：
   `gh release edit vX.Y.Z --draft=false`，
   或在 Actions 里手动运行 `Release` 并勾选 `publish: true`。

## 不做的事

见 `技术选型与路线图.md` §1.4：不做 IDE、不做笔记库、v1 不做插件/同步/协作、不做 WYSIWYG。

README 截图（可选，发版前刷新）：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
Start-Process "$env:LOCALAPPDATA\6byte\6byte.exe"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/capture-screenshots.ps1
```

结果写入 `docs/assets/`（欢迎页 / 编辑器 + 分屏预览 / 跨文件搜索 / 大文件预览）。
