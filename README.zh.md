# 6byte

> 跨平台、轻量、AI 原生的文本工作台。打开 `md` / `txt` / `log` 就能写，数据留在本机。

[![CI](https://github.com/wufangqi/6byte/actions/workflows/ci.yml/badge.svg)](https://github.com/wufangqi/6byte/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/wufangqi/6byte?label=release)](https://github.com/wufangqi/6byte/releases/latest)
[![License](https://img.shields.io/github/license/wufangqi/6byte)](./LICENSE)

**中文** · [English](./README.md)

**状态**：v0.2.0（2026-10-27）已发布：M0–M3、AI 审阅优先的改写、工作区文件树、Markdown 默认预览与导出一致性；安装包覆盖 Windows、Linux、macOS。

![欢迎页](./docs/assets/welcome.png)
![编辑器与 Markdown 分屏预览](./docs/assets/editor-preview.png)

## 能做什么

- **写作**：多标签、会话恢复、最近文件、按标签保留撤销历史、拖拽打开、中键关闭；标签右键或 `F2` 重命名文件。
- **Markdown**：打开 md 直接显示渲染结果，`<>` 或 `Ctrl+Shift+M` 切换源码；分屏预览、导出 HTML、大纲跳转、Mermaid / KaTeX、Shiki 高亮、图片粘贴，分隔条可拖拽调宽；Mermaid 图可在预览内缩放（25%–300%）、拖拽平移与重置。
- **大文件**：≤5 MB 全功能；5–20 MB 简化装饰；20–100 MB 只读虚拟滚动；>100 MB memmap 只读（上限 512 MB）。
- **编码与数据安全**：UTF-8 / BOM / UTF-16 / GBK 等检测，按原编码与换行回写；有损解码保存前确认；原子保存；外部修改检测与冲突三选一。
- **文件树**：打开一个文件夹，目录按需逐层展开（每次点开一层，不扫描整棵树），单击文件打开。隐藏名、依赖目录和符号链接不列出。关闭文件夹不会关掉已经打开的标签。状态栏左侧面板按钮或 `Ctrl+Shift+E` 可快速显示/隐藏，折叠状态重启后保持。
- **搜索**：`Ctrl+F` 查找替换（正则、捕获组），`Ctrl+Shift+F` 跨文件 grep（有工作区时从工作区根开始，否则从当前文件所在目录；跳过二进制与依赖目录）。
- **AI（v0.2.0）**：模型服务（服务商 / 模型两级，密钥进系统钥匙串）；选中文字后可用 `Ctrl+K` 改写，`Tab` 接受、`Esc` 取消；候选先内联审阅再改正文；AI 面板为可调宽右侧停靠，状态栏可开关，标题栏「悬浮标」控制选区入口；支持一键润色 / 翻译 / 总结、多轮追问、本机会话历史、`Ctrl+P` 命令面板、`@` 引用、只读询问与默认关闭的自动补全。Markdown 预览里选中文字也可以改写。
- **界面**：中英双语、深色 / 浅色 / 跟随系统、自定义标题栏；`.txt` 与未命名笔记自动换行。设置（`Ctrl+,`）为标签页，含通用 / 模型 / 服务商 / 对话与限额 / 访问限制 / 用量统计；帮助菜单含「关于 6byte」（版本 / 平台 / Tauri）与键盘快捷键。
- **轻量**：Tauri 2 + 系统 WebView，安装包约 5 MB，冷启动约 0.1 s。

## 安装

从 [Releases](https://github.com/wufangqi/6byte/releases/latest) 下载：

- `6byte_0.2.0_x64-setup.exe` — NSIS，单用户安装，无需管理员权限（推荐）
- `6byte_0.2.0_x64_en-US.msi` — MSI，适合企业部署 / 静默安装

**Linux**

- `6byte_0.2.0_amd64.deb` — Debian / Ubuntu：`sudo apt install ./6byte_0.2.0_amd64.deb`
- `6byte_0.2.0_amd64.AppImage` — 免安装：`chmod +x 6byte_0.2.0_amd64.AppImage && ./6byte_0.2.0_amd64.AppImage`

依赖 WebKitGTK 4.1（Ubuntu 22.04+ / Debian 12+ 为 `libwebkit2gtk-4.1-0`）。

**macOS**

- `6byte_0.2.0_universal.dmg` — 通用包（Apple Silicon + Intel）。未签名、未公证：首次打开需右键 →「打开」，或执行 `xattr -dr com.apple.quarantine /Applications/6byte.app`。

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

前端单测 **303**、Rust **112**（+4 ignored）。最新安装版 E2E **107/107（24 步，2026-10-29）**，含文件树两步；新构建的隔离 release 二进制已运行本地 SSE mock 驱动的 AI E2E（改写审阅、原生只读工具调用、答案跳转/插入），**6/6** 通过。CI 覆盖 Windows / macOS / Ubuntu。性能数据见 [docs/perf.md](./docs/perf.md)。

## 已知限制

- 20–100 MB 只读；>100 MB 走 memmap 只读（≤512 MB），都不能编辑保存。
- 脏标记只增不减：撤销回保存点仍显示未保存。
- 混合换行文件保存时统一为主导 EOL（保存前确认）。
- AI 需自备 OpenAI 兼容服务与 API Key；密钥存系统钥匙串，不写配置文件。
- 无自动更新、无便携版、无系统右键集成（M4）。
- 文件树只读：不能在树里新建或删除，不显示 Git 状态，不监听整棵目录（只监听已打开的文件），跳过符号链接。单层最多列出 2000 项；文件可在标签右键或 `F2` 重命名。
- 自定义标题栏目前只在 Windows 验证过；Linux / macOS 安装包由 CI 构建，尚未在实机做冒烟验收。

## 明确不做

6byte 保持「可审阅的编辑器 + AI」，不做平台：不做 WYSIWYG / 富文本、知识图谱、插件系统、实时协作、通用聊天侧栏，也不做跨文件自治写入。这些会拿「先审阅再写入」换取无法验证的范围。

## 路线图

下一步：长 Markdown 预览基准（T71）、共享 DocumentModel（T72），以及 AI 审阅 / 生命周期的剩余收口（T73–T76）。v0.2.0 已发布 AI 信任闭环、工作区上下文、Markdown 预览 / 导出一致性、文件重命名、图表缩放与多平台安装包。详见 [docs/待办清单.md](./docs/待办清单.md)。

## 文档

- [技术选型与路线图](./技术选型与路线图.md)
- [待办与进度](./docs/待办清单.md) · [变更记录](./CHANGELOG.md)
- [性能实测](./docs/perf.md) · [发布验收](./docs/release-checklist.md)
- [UI 规范](./docs/ui-guidelines.md) · [项目梳理](./docs/项目梳理.md) · [工作区文件树 PRD](./docs/PRD-工作区文件树.md)
- [参与贡献](./CONTRIBUTING.md)

## 许可证

[MIT](./LICENSE)
