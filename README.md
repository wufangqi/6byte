# 6byte

> 跨平台、轻量、AI 原生的文本工作台。打开 `md` / `txt` / `log` 就能写，数据留在本机。

[![CI](https://github.com/wufangqi/6byte/actions/workflows/ci.yml/badge.svg)](https://github.com/wufangqi/6byte/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/wufangqi/6byte?label=release)](https://github.com/wufangqi/6byte/releases/latest)
[![License](https://img.shields.io/github/license/wufangqi/6byte)](./LICENSE)

**中文** · [English](./README.en.md)

**状态**：v0.1.7（2026-10-25）已发布，含 M0–M3。`master` 上的一键动作与 `Ctrl+K` / Tab 接受已合入，随下一版发布。

![欢迎页](./docs/assets/welcome.png)
![编辑器与 Markdown 分屏预览](./docs/assets/editor-preview.png)

## 能做什么

- **写作**：多标签、会话恢复、最近文件、按标签保留撤销历史、拖拽打开、中键关闭。
- **Markdown**：分屏预览、导出 HTML、大纲跳转、Mermaid / KaTeX、Shiki 高亮、图片粘贴；分隔条可拖拽调宽。
- **大文件**：≤5 MB 全功能；5–20 MB 简化装饰；20–100 MB 只读虚拟滚动；>100 MB memmap 只读（上限 512 MB）。
- **编码与数据安全**：UTF-8 / BOM / UTF-16 / GBK 等检测，按原编码与换行回写；有损解码保存前确认；原子保存；外部修改检测与冲突三选一。
- **搜索**：`Ctrl+F` 查找替换（正则、捕获组），`Ctrl+Shift+F` 跨文件 grep（跳过二进制与依赖目录）。
- **AI**：模型服务（服务商 / 模型两级，密钥进系统钥匙串）；`Ctrl+K` 或标题栏「模型」做选区改写，`Tab` 接受、`Esc` 取消；一键润色 / 翻译 / 总结；自动补全（默认关闭）。
- **界面**：中英双语、深色 / 浅色 / 跟随系统、自定义标题栏；`.txt` 与未命名笔记自动换行。
- **轻量**：Tauri 2 + 系统 WebView，安装包约 5 MB，冷启动约 0.1 s。

## 安装

从 [Releases](https://github.com/wufangqi/6byte/releases/latest) 下载：

- `6byte_0.1.7_x64-setup.exe` — NSIS，单用户安装，无需管理员权限（推荐）
- `6byte_0.1.7_x64_en-US.msi` — MSI，适合企业部署 / 静默安装

卸载走「设置 → 应用」或安装目录下的 `uninstall.exe`。

## 开发

```bash
# 依赖：Node 20+ / pnpm 11 / Rust stable + 平台构建工具（Windows 为 MSVC）
pnpm install
pnpm tauri dev      # 桌面版
pnpm tauri build    # 安装包 → src-tauri/target/release/bundle/
```

完整命令、目录约束、提交规范与发布流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 验证

`tsc` / `eslint` / `prettier` / `cargo fmt` / `clippy` 全绿；前端单测 **147**、Rust **75**（+4 ignored）、安装版 E2E **91/91（22 步）**；CI 覆盖 Windows / macOS / Ubuntu。性能数据见 [docs/perf.md](./docs/perf.md)。

## 已知限制

- 20–100 MB 只读；>100 MB 走 memmap 只读（≤512 MB），都不能编辑保存。
- 脏标记只增不减：撤销回保存点仍显示未保存。
- 混合换行文件保存时统一为主导 EOL（保存前确认）。
- AI 需自备 OpenAI 兼容服务与 API Key；密钥存系统钥匙串，不写配置文件。
- 无自动更新、无便携版、无系统右键集成（M4）。
- 自定义标题栏目前只在 Windows 验证过。

## 路线图

下一步：工作区文件树（[T54 / PRD](./docs/PRD-工作区文件树.md)，会替换当前「打开文件夹」批量开标签的行为），然后是 M4 分发。详见 [docs/待办清单.md](./docs/待办清单.md)。

## 文档

- [技术选型与路线图](./技术选型与路线图.md)
- [待办与进度](./docs/待办清单.md) · [变更记录](./CHANGELOG.md)
- [性能实测](./docs/perf.md) · [发布验收](./docs/release-checklist.md)
- [UI 规范](./docs/ui-guidelines.md) · [项目梳理](./docs/项目梳理.md) · [工作区文件树 PRD](./docs/PRD-工作区文件树.md)
- [参与贡献](./CONTRIBUTING.md)

## 许可证

[MIT](./LICENSE)
