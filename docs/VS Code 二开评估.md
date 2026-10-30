# 决策备忘录：是否基于 VS Code 二开

> 基线：2026-10-30，6byte **v0.3.0**（2026-10-29 发布；工作树含未发布的 `@` 提及标签、F2 重命名等改动）。
> 事实来源：一手链接见 §2；6byte 侧数据来自 `docs/perf.md` 与本仓库代码。

> **基线变化提示**：本文最初的判断基于 v0.1.7。此后几天仓库已合入 T54 文件树、T56 内联 AI 审阅、T57 上下文 1.0、T58 `Ctrl+P` 与 `@` 引用、T59–T67 只读问答与原生 tool calling、T72 文档结构、T82 本地会话历史、T84 预览选区改写——**上一份建议里的 Step 1–3 基本已经自己走完了**。这不改变结论，反而加强了它：见 §0.1。

---

## 0. 结论

**取决于目标，两个分支的答案相反。**

| 如果目标仍是 | 结论 | 一句话理由 |
|---|---|---|
| **A. 轻量文本 / 日志 / Markdown 工作台** | **不合理** | 你的护城河全在底座里（4.88 MB、94 ms、编码原样回写、100 MB memmap），换底座等于把护城河填了，去换一堆你不需要的能力。 |
| **B. AI 编码 IDE（与 Cursor / Zed 正面竞争）** | **合理，但 6byte 不是起点，fork 也不是护城河** | fork 只解决「入场资格」；真正的竞争在 workbench 改造、分发与生态，而这三样恰好都是重资产。 |

三条硬理由：

1. **差异化在底座，不在功能。** 编码无损回写、memmap 大文件、94 ms 冷启动、4.88 MB 安装包——这些在 VS Code 上要么做不到，要么必须 patch 核心。迁移之后，你和「装了一个 AI 插件的 VS Code」没有区别。
2. **AI native 的关键交互，扩展 API 做不到。** 官方允许扩展改 workbench 的口子只有四类（Views Container / TreeView / Webview / StatusBar）。Cursor 式 Tab 预测、inline diff 原位审阅、agent 面板，都要改 workbench——也就是必须 fork，也就是进入 Cursor 的主场。
3. **法律与生态是两个硬约束。** Marketplace 明确禁止 fork 使用（ToU §3）；Open VSX 实测缺 C# / C++ / Remote-SSH / Copilot / Pylance。你要么自建市场，要么接受「装不上主流插件」。

---

## 1. 一个值得注意的巧合

Cursor 2023-04 的 changelog 原话：*"transitioned to building Cursor on top of a fork of VSCodium, moving away from our previous Codemirror-based approach"*（[changelog](https://cursor.com/changelog/0-2-0)）。

**6byte 现在的位置，正是 Cursor 0.2 之前的位置。** 这条路确实能走通——但 Cursor 走它的时候，已经有产品、用户和融资；而且它是把 CodeMirror 换掉、从头改 workbench。你现在拥有的，是一个在编码与大文件上**比 VS Code 更好用**的 5 MB 编辑器——这是完全不同的资产。

---

## 2. 能做什么，不能做什么（一手事实）

### 2.1 许可与商标

| 项 | 事实 |
|---|---|
| 源码许可 | vscode 仓库 MIT（[LICENSE.txt](https://raw.githubusercontent.com/microsoft/vscode/main/LICENSE.txt)） |
| 官方发行版 | 另按 Microsoft 产品许可（[license](https://code.visualstudio.com/license)） |
| 专有部分 | 商标/图标/产品名、Marketplace 集成、Remote Development 部分代码、C#/.NET debug handshake、遥测与更新端点，全部经 `product.json` 注入（[Differences](https://raw.githubusercontent.com/wiki/microsoft/vscode/Differences-between-the-repository-and-Visual-Studio-Code.md)） |
| 合规做法 | 自建 `product.json`（不填 gallery/serviceUrl、telemetry、update URL）+ 换品牌图标。VSCodium 走的就是这条路（[vscodium.com](https://vscodium.com/)） |

### 2.2 Marketplace 是硬墙（不是灰区）

> ToU §3：*"You may not import, install, or use Offerings published by Microsoft or GitHub... in any products or services except for the In-Scope Products and Services."*

官方 FAQ 明确把 Code-OSS fork 归为「alternative products」，不得访问 Marketplace（[FAQ](https://raw.githubusercontent.com/microsoft/vscode-docs/60ef30845b5493aac60b92302d349de138a2f2cc/docs/supporting/faq.md)）。

### 2.3 Open VSX 的实际缺口（实测 `open-vsx.org` API 均 404）

`ms-dotnettools.csharp`、`ms-vscode-remote.remote-ssh`、`ms-vscode.cpptools`、`GitHub.copilot`、`ms-python.vscode-pylance` —— 全部不存在。社区替代只有一个非官方 C# 扩展。

**对一个面向中国开发者的 AI 编辑器来说，装不上 C#/C++/远程开发插件，是产品级的伤口。**

### 2.4 扩展 API 的天花板

- 能：`InlineCompletionItemProvider`、Language Model API、Language Model Tools、MCP、Custom Editor / Webview、TreeView / StatusBar（[AI extensibility](https://code.visualstudio.com/api/extension-guides/ai/ai-extensibility-overview)）。
- 不能：替换编辑器内核、改标题栏 / tab / 命令面板 / 编辑器渲染层、Cursor 式 Tab 跳转预测。官方给扩展改 workbench 的面只有四项（[extending-workbench](https://code.visualstudio.com/api/extension-capabilities/extending-workbench.md)）。
- `chat participant` 已被官方标 deprecated（"not supported in the Copilot harness"）。
- Positron（另一个 fork 产品）官方 FAQ 说得最直接：*"VS Code's Extension API doesn't provide enough leverage to modify the main workbench surface"*（[FAQ](https://positron.posit.co/faqs.html)）。

### 2.5 上游节奏

VS Code 月更（1.144 发布于 2026-10-28，[updates](https://code.visualstudio.com/updates/v1_144)）。每次 diff 规模与各 fork 的合并工时没有公开数据——但月更意味着**每月一次的结构性合并**是常态，不是偶发。

### 2.6 隐私叙事的真实成本

extension host 与 IDE 同权限：可读写任意文件、发网络请求、起进程、改设置（[security 文档](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security)）。fork 之后你还**失去** Marketplace 的签名校验、恶意扫描、block list 自动卸载。

Trae 是个可引用的反面案例：关闭遥测后仍被观测到约 7 分钟内 500 次请求 / 26 MB，官方后来承认该开关只覆盖 VS Code 框架遥测（[The Register](https://assets.theregister.com/2025/07/28/bytedance_trae_telemetry/)）。

**「数据不出本机」在 fork 上要自证，成本比在自研底座上高一个数量级。**

---

## 3. 能力迁移表：你的真本事还剩多少

| 6byte 能力 | VS Code 现状 | 实现路径 | 代价 |
|---|---|---|---|
| 按原编码 / BOM / EOL 回写，lossy 拦截 | 有 `files.encoding` + `files.autoGuessEncoding` + 转换命令，但**没有「静默按每文件原编码保存」**；编码是全局/工作区级设置 | 扩展可提示、可转换；要真正保真必须改核心 | 中 |
| 100 MB / 512 MB memmap 只读 | 大文件会关闭 tokenization 并仍受内存约束，做不到 512 MB | 自建只读视图（Webview + Rust sidecar） | 高 |
| 4.88 MB 安装包 / 94 ms 冷启动 | Electron 系：安装包数百 MB、冷启动 1–2 s（量级差异，非优化能补） | 无 | **不可逆** |
| 跨文件 grep | 内置搜索足够好 | 免费获得 | 0 |
| 外部修改冲突处理 | 有 | 免费获得 | 0 |
| 每标签撤销历史 | 天然具备 | 免费获得 | 0 |
| 工作区 / 文件树 / 命令面板 / LSP / 终端 / 多窗口 | 有 | 免费获得 | 0 |
| AI native UX（Tab 预测 / diff 审阅 / agent） | 扩展只能做到一部分 | 必须改 workbench | 高 |

结论：**你会用「不可逆的三项」换「免费的五项」，再把「高成本的两项」重新做一遍。**

---

## 4. 三条现实路线

### 路线 1（推荐）· 不换底座，把 AI native 做实
见 [`AI-native-演进建议.md`](./AI-native-演进建议.md) 的 Step 1–3：diff 审阅闭环 → 上下文工程 → 工作区一层。
成本 1–3 周，保住全部护城河，且做完之后你再评估「要不要 IDE 化」时，手里是一个更强的产品而不是一个空壳。

### 路线 2（可选）· 用 VS Code 扩展验证需求
把你的 AI 改写 / 补全包成一个扩展，1–2 周。
**注意它能验证什么、不能验证什么**：能验证「有人愿意为你的 AI 交互装东西」，不能验证「人们想要你的编辑器」——因为扩展跑在别人的产品里。

### 路线 3 · 真 fork
MVP 3–6 人月（构建 / 签名 / 三平台 / 自建市场替代 / Rust sidecar 接入），之后永久合并税（每月 1–4 人天量级）。
**只在目标明确转向 B 分支时成立。**

---

## 5. 如果真想 fork，唯一正确的姿势

1. **不要 fork 源码改 UI。** 把 Rust 内核（codec / bigfile / grep / ai）做成 sidecar，VS Code 当宿主。这样你的差异化还留在自己手里，而不是散在 200 万行 TypeScript 里。
2. **不要试图保留「轻」。** 接受 200 MB+ 与 1–2 s 冷启动，否则每天都在和底座打架。
3. **先找一个「体积不重要、合规才重要」的垂直场景。** 例如内网 / 涉密环境的本地模型 IDE——在这个场景里，4.88 MB 没有意义，而「不联网、可审计、编码无损、大日志可读」才是采购理由。**这可能是 fork 唯一站得住的商业理由。**
4. **止损线**：连续两个月无法在 2 人天内完成一次上游合并，或核心 UX 需要持续 patch 超过 5 个文件——停。

---

## 6. 五问判断清单（有一项答「否」就别 fork）

1. 你的目标用户是否**已经在用** VS Code？如果是，你的差异必须是「VS Code 做不到的」，而不是「VS Code 没装的」。
2. 你的差异化是否**能离开底座存在**？（编码 / 大文件 / 轻量 → 说明底座本身就是产品）
3. 你能否接受**永久失去** 4.88 MB 与 94 ms 这两个卖点？
4. 你是否有人力**每月**跟一次上游合并？
5. 如果 Cursor / 字节 / 腾讯明天做了同样的事，你剩下什么？

---

## 7. 一句话

「基于 VS Code 二开」不是技术选型，是**产品宣言**：它等于宣布「我要进 IDE 市场」。在宣布之前，先回答一个问题——你的差异能不能撑住正面竞争。而 6byte 现在唯一的差异（编码无损、大文件、轻），恰好是 VS Code 里最难做、也最不值得为它 fork 的三项。