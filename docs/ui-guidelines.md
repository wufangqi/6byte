# UI 规范（6byte 编辑器）

> 目的：新增界面时不再逐处写颜色/圆角/字号，先查这里。实现位于 `src/styles.css` 顶部的 `:root` 变量；组件只引用变量与下列公共类，不写内联样式（布局尺寸除外）。

## 1. 颜色

两套主题共享同一组语义变量，切换只改值（`src/features/theme.ts` 写入 `data-resolved`）。

| 变量 | 用途 |
|---|---|
| `--bg` | 窗口底色（标题栏、标签栏、状态栏） |
| `--bg-editor` | 编辑区、预览、输入框底色 |
| `--bg-elevated` | 菜单、对话框、面板、次级按钮 |
| `--bg-active-line` | 列表/菜单悬停、当前行 |
| `--fg` / `--fg-dim` | 正文 / 次要信息 |
| `--border` | 分隔线与控件描边 |
| `--accent` / `--accent-dim` | 强调色 / 主按钮底色 |
| `--selection` | 文本选中、开关开启底 |
| `--danger` / `--warn` | 错误 / 警告文字 |
| `--accent-soft` / `--danger-soft` / `--warn-soft` | 对应状态的浅底 |
| `--accent-line` / `--danger-line` / `--warn-line` | 对应状态的描边 |
| `--code-bg` | 行内代码底色 |
| `--overlay` / `--drop-overlay-color` | 弹层遮罩 / 拖拽遮罩 |
| `--shadow-menu` / `--shadow-dialog` | 菜单 / 对话框阴影 |

规则：

- 不在组件里写 `rgba(...)`；浅色主题必须能在不改组件的前提下成立。
- 危险/警告的浅底与描边一律用 `-soft` / `-line`，不要单独配透明度。
- 强调色只用于「可操作」与「已开启」，不用于装饰。

## 2. 尺寸与文字

| 变量 | 值 | 用途 |
|---|---|---|
| `--radius-sm` | 4px | 小控件、菜单项、标签页关闭 |
| `--radius-md` | 6px | 按钮、输入框、chip、卡片 |
| `--radius-lg` | 10px | 对话框、搜索面板 |
| `--text-xs` | 11px | 工具条按钮、辅助标签、快捷键 |
| `--text-sm` | 12px | 状态栏、字段标签、面板说明 |
| `--text-md` | 13px | 界面正文（菜单、按钮、输入） |
| `--text-base` | 14px | 预览正文 |

固定高度（不随主题变化）：

| 区域 | 高度 |
|---|---|
| 标题栏 | 36px（与标签栏同高） |
| 标签栏 | 36px |
| 状态栏 | 26px |
| 预览工具条 | 32px |
| 标题栏控件 / chip | 24px |
| 工具条小按钮、状态栏按钮 | 20px |

## 3. 控件约定

- **主按钮**：`.btn .btn--primary`，每个视图最多一个。
- **次按钮**：`.btn`，用于取消、测试、增删等。
- **危险按钮**：`.btn .btn--danger`，用于不可撤销操作。
- **标题栏入口**：`.titlebar__chip`；开启态加 `.titlebar__chip--on`；设置类入口加 `.titlebar__chip--outline`。不要再做填充式 pill——标题栏不放主按钮。
- **工具条小按钮**：状态栏 `.statusbar__action` / `.statusbar__icon` / `.statusbar__source`、预览 `.markdown-preview__export` / `__outline-toggle` / `__source`，统一 20px 高、`--radius-sm`、`--text-xs`。
- **输入**：`.ai-settings__input` / `.grep__input` / `.ai-stream__input`，32px 高、`--radius-md`、`--font-mono`（正文类输入用 UI 字体）。
- **列表项**：菜单 `.menu__item`、服务商/模型 `.ai-settings__model`、最近打开 `.link`，悬停用 `--bg-active-line`，选中用 `--accent` 描边 + `--accent-soft` 底。
- **对话框**：`.dialog` + `.dialog__head`（标题 + 右上关闭）+ `.dialog__actions`；长表单把操作区做成 sticky footer。

## 4. 交互状态

- 所有可点元素都要有 `:hover`；按钮/输入/摘要用全局 `:focus-visible`（2px 强调色描边，偏移 1px）。
- 禁用态：`opacity: .45`（按钮）或 `.55`（输入），并保持 `cursor: default`。
- 过渡统一 120ms：`background`、`border-color`、`color`、`box-shadow`、`opacity`。
- 拖拽/分栏只用 `.split__divider`，键盘方向键可调，双击回到 50%。

## 5. 主题

- 深色为默认；浅色由 `data-resolved="light"` 覆盖变量。
- 新增颜色时同时补两套值，否则浅色会退回深色值。
- 预览内代码高亮（Shiki）、Mermaid、KaTeX 由 `renderMarkdown` / `diagrams.ts` 按主题重渲染，不写死在 CSS。

## 6. 自检清单（改 UI 后）

1. `pnpm exec tsc --noEmit`、`pnpm exec eslint .`、`pnpm exec prettier --check .` 全绿。
2. `pnpm exec vitest run` 全绿（纯样式改动也应通过）。
3. 深/浅两套主题各看一遍：标题栏、标签栏、状态栏、菜单、对话框、搜索面板、空状态。
4. 键盘走一遍：Tab 到控件有焦点环；Esc 能关菜单/对话框/搜索。
5. 构建并在安装版跑 `scripts/e2e-smoke.ps1`（24 步 / 101 条断言，含文件树第 23–24 步）。
