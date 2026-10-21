# AI 原生文本编辑器

> 跨平台、极轻、AI 原生的文本工作台。打开 `md` / `txt` / `log` 就能用，数据留在本机。

**当前阶段：M0 骨架已就绪（可打开 / 编辑 / 保存 / 多标签 / 拖拽，编码检测 + 原编码回写）**

技术选型、里程碑与风险登记册见：[技术选型与路线图.md](./技术选型与路线图.md)

---

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面运行时 | Tauri 2（系统 WebView，包体小） |
| 前端 | React 19 + TypeScript + Vite |
| 编辑器 | CodeMirror 6 |
| 核心层（Rust） | 编码检测与回写（`encoding_rs` + `chardetng`）、原子保存 |
| 状态 | zustand |

## 快速开始

```bash
# 依赖：Node 20+ / pnpm / Rust（stable）+ MSVC 构建工具
pnpm install

# 桌面版（推荐）
pnpm tauri dev

# 只调 UI（浏览器预览，无文件读写）
pnpm dev
```

> **Windows 注意**：本仓库的 `pnpm-workspace.yaml` 设置了 `nodeLinker: hoisted`。
> 原因是当前 Windows 环境下 Node 的 ESM 解析不穿透 pnpm 的 junction 链接，
> 默认 isolated 布局会让 vite 报 `Cannot find package 'picomatch'`。改用扁平
> node_modules 可彻底规避，代价是依赖隔离性弱一些。

打包：

```bash
pnpm tauri build          # 产物在 src-tauri/target/release/bundle/
pnpm tauri build --debug  # 快速出包，便于验证
```

## 已验证

| 检查项 | 命令 | 结果 |
|---|---|---|
| 前端类型检查 | `pnpm exec tsc --noEmit` | ✅ 通过 |
| 前端打包 | `pnpm build` | ✅ 通过（dist 约 813 KB / gzip 272 KB） |
| Rust 编译 | `cargo check --all-targets` | ✅ 通过 |
| 编码单元测试 | `cargo test --lib` | ✅ 8/8 通过（UTF-8/BOM/GBK/UTF-16LE/CRLF/不可表示字符） |
| 桌面端启动 | `pnpm tauri dev` | ⏳ 需在本机 GUI 环境验证 |

## 已实现（M0 + M1 部分）

- [x] 打开 / 保存 / 另存为（Ctrl+O / Ctrl+S / Ctrl+Shift+S）
- [x] 多标签、脏标记、Ctrl+W 关闭、Ctrl+N 新建
- [x] 拖拽文件到窗口打开
- [x] 会话恢复（重启后重新打开上次的文件）与最近文件
- [x] 编码检测：UTF-8 / UTF-8 BOM / UTF-16LE / UTF-16BE / 其他（chardetng 猜测，含 GBK）
- [x] **原编码 / BOM / 换行符回写**（不会把 GBK 文件悄悄存成 UTF-8）
- [x] 原子保存（临时文件 + rename）
- [x] 状态栏显示编码 / 换行符 / 行数 / 字符数 / 未保存状态
- [x] 解码有损时状态栏告警（防止二次损坏）

## 尚未实现（按路线图推进）

- [ ] 正则查找替换、跨文件搜索（M1）
- [ ] 大文件分级加载（M1）
- [ ] Markdown 分屏预览、图片粘贴（M2）
- [ ] AI 层：内联改写 / 一键动作 / Provider 抽象（M3）
- [ ] 便携版、winget、自动更新（M4）

## 目录结构

```
src/                 React 前端（仅 src/editor 可 import CodeMirror）
  editor/            CM6 封装与扩展
  features/          标签栏 / 状态栏 / 欢迎页
  ipc/               所有 Tauri command 的类型化封装
  stores/            zustand
src-tauri/           Rust 核心层
  src/codec.rs       编码检测与回写（含单元测试）
  src/commands.rs    read_file / write_file
docs/                设计文档（见根目录路线图）
scripts/gen_icons.py 生成应用图标
```

## 已知限制

- 切换标签会重置该标签的撤销历史（M0 取舍，后续改为多文档共享 EditorView）。
- 尚未做文件监听：文件被外部修改时不会自动提示（M1 补）。
- 大文件未分级，超过 ~20 MB 会明显变慢（M1 补）。

## 许可证

MIT（待补 LICENSE 文件）