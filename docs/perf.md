# 性能实测（2026-10-21）

对应待办 T07。目标是把路线图 §0 的性能预算从「口号」变成「数字 + 复现方法」。

## 环境

| 项 | 值 |
|---|---|
| 机器 | Intel Core i5-1335U（10 核 12 线程，1.3 GHz 基频）/ SK hynix BC901 NVMe SSD |
| 系统 | Windows 11 专业版 10.0.26300 |
| 构建 | `pnpm tauri build`（release, opt-level 3），WebView2 Runtime 148.0.3967.83 |
| 应用 | 0.1.0 实测；v0.1.2 起产品名为 6byte，安装目录 `%LOCALAPPDATA%\6byte` |
| 测量时间 | 2026-10-21，已预热（WebView2 profile 已存在） |

> 说明：这是**开发机上的单次抽样**，不是严格的基准测试。数字用于发现数量级问题与回归，
> 不作为对外承诺；发布前会在干净机器上复测。

## 结论速览

| 指标 | 预算 | 实测 | 判定 |
|---|---|---|---|
| 冷启动（进程启动 → 窗口标题就绪） | ≤ 1.5 s | 中位 **0.094 s**，P95 **0.159 s** | ✅ 远优于预算 |
| 10 MB 打开（Rust 读 + 解码） | ≤ 500 ms | **14.1 ms** | ✅（仅后端路径） |
| 10 MB 保存（编码 + 原子写） | — | **21.9 ms** | ✅ |
| 100 MB 行索引（首次建索引） | ≤ 150 ms | **64.6 ms**（1,542,024 行） | ✅ |
| 大文件单次区间读取（400 行） | ≤ 5 ms | **0.37–0.87 ms** | ✅ |
| 35 MB 打开到首屏（只读预览） | ≤ 1 s | **458 ms**（含应用启动，CDP 计时） | ✅ |
| 120 MB 打开到首屏（memmap 只读，E2E） | ≤ 2 s | 实测通过（E2E 第 15 步，含应用启动与会话恢复） | ✅ |
| 跨文件 grep（1000 个文件） | ≤ 2 s | **64.5 ms**（每文件 20 行） | ✅ |
| 输入延迟 P95（按键 → 编辑器布局） | ≤ 16 ms | 1000 行 L0 **5.6 ms**；10 MB L1 **3.0 ms**；19 MB L1 **2.7 ms** | ✅ |
| 3 文件内存 | ≤ 260 MB（空载基线 ≤230 MB） | 空文档私有内存 **220 MB**（工作集 427 MB）；关 GPU 可到 159 MB | ⚠️ 预算按实测修订（见 §2.3） |
| KaTeX 字体与 Mermaid | — | `mermaid.core` 677 KB、`katex` 256 KB 及 KaTeX 字体按需加载，只影响包体不影响首屏 | ✅ |
| 前端包体 | — | 主包 **996 KB / gzip 338 KB**；dist 总计 **8.57 MB**（Shiki/KaTeX/Mermaid 与 KaTeX 字体按需） | ✅ |
| 安装包 | ≤ 20 MB | NSIS 4.88 MB / MSI 5.70 MB（含 KaTeX/Mermaid 资源与模型客户端） | ✅ |

## 1. 冷启动

方法：连续 20 次「启动进程 → 轮询 `MainWindowTitle == "6byte"`」，每次之间强制结束进程，
不重启系统、不清 WebView2 profile（即「用户日常二次打开」场景，非真正冷磁盘）。

| 统计量 | 值 |
|---|---|
| 中位数 | **0.094 s** |
| P95 | 0.159 s |
| 最小 / 最大 | 0.076 s / 0.219 s |
| 全部样本 | 0.219, 0.159, 0.086, 0.102, 0.090, 0.139, 0.132, 0.092, 0.093, 0.108, 0.092, 0.090, 0.097, 0.076, 0.094, 0.076, 0.105, 0.110, 0.112, 0.092 |

复现：

```powershell
$exe = "$env:LOCALAPPDATA\6byte\6byte.exe"
$times = @()
for ($i = 0; $i -lt 20; $i++) {
  Get-Process 6byte -EA SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 400
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Start-Process $exe
  while ($sw.ElapsedMilliseconds -lt 15000) {
    $p = Get-Process 6byte -EA SilentlyContinue | Select-Object -First 1
    if ($p -and $p.MainWindowTitle -eq "6byte") { break }
    Start-Sleep -Milliseconds 20
  }
  $times += [math]::Round($sw.Elapsed.TotalSeconds, 3)
}
($times | Sort-Object)[9]   # 中位数
```

注意：这是「文件系统缓存 + WebView2 已初始化」的热启动。真正冷启动（重启后首次）需要
单独在干净机器上测，预计仍在 0.5 s 量级（WebView2 初始化占大头）。

## 2. 内存

方法：单次启动、空闲 10 s 后，按父子进程树汇总 `WorkingSet64` 与 `PrivateMemorySize64`。
WebView2 进程间有大量共享页，**求和应看私有内存**（工作集会重复计算共享页）。

### 2.1 进程明细（默认配置，空文档）

| 进程 | 角色 | 工作集 | 私有 |
|---|---|---|---|
| aneditor | Tauri 宿主 | 25.1 MB | 4.9 MB |
| msedgewebview2 | browser | 163.2 MB | 74.2 MB |
| msedgewebview2 | gpu-process | 78.0 MB | 66.2 MB |
| msedgewebview2 | renderer | 85.9 MB | 43.5 MB |
| msedgewebview2 | utility ×2 | 57.6 MB | 23.7 MB |
| msedgewebview2 | crashpad | 10.2 MB | 2.5 MB |
| **合计** | 7 个进程 | **~425 MB** | **~215 MB** |

### 2.2 配置矩阵（空文档，私有内存口径）

通过 WebView2 原生环境变量 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 注入浏览器开关，各启动一次：

| 配置 | 进程数 | 工作集 | 私有内存 |
|---|---|---|---|
| 默认（GPU 加速开） | 7 | 427 MB | **220.3 MB** |
| 默认（重复测量） | 7 | 424 MB | 220.4 MB |
| `--disable-gpu` | 7 | 399 MB | 170.2 MB |
| `--disable-gpu --in-process-gpu` | 6 | 373 MB | **159.0 MB** |
| `--js-flags=--max-old-space-size=128` | 7 | 425 MB | 221.9 MB |

结论：内存几乎全部来自 WebView2 自身（browser + GPU + renderer + utility）。
应用代码侧（817 KB 前端包、空文档）没有可压缩空间；JS 堆上限也不影响总量。
GPU 进程在这台核显机器上独占约 50–66 MB 私有内存。

### 2.3 决策（T23 结论）

1. **不改默认启动参数**：`--disable-gpu` 会把合成/滚动降到软件路径，对文本编辑器的手感是净亏，
   50 MB 换不来体验。
2. **预算改为「基线 + 增量」**：空载私有内存 ≤ 230 MB，每打开 1 MB 文本增量 ≤ 1.5 MB
   （3 个中等文件 ≈ 260 MB）。已同步到路线图 §0 与 README。
3. **提供逃生舱**：需要把内存压到最低的用户可自行设置环境变量（已验证有效，无需改代码）：

   ```powershell
   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--disable-gpu --in-process-gpu'
   ```

4. 真正的「3 文件」数字要等 M1（T12/T14）提供可脚本化的打开入口后补测；当前 UI 无法自动打开文件。

复现：

```powershell
$exe = "$env:LOCALAPPDATA\6byte\6byte.exe"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--disable-gpu --in-process-gpu'  # 可留空做基线
Start-Process $exe; Start-Sleep -Seconds 10
$root = (Get-Process 6byte).Id
$procs = Get-CimInstance Win32_Process
$desc = @($root); $changed = $true
while ($changed) {
  $changed = $false
  foreach ($p in $procs) {
    if ($desc -contains $p.ParentProcessId -and $desc -notcontains $p.ProcessId) {
      $desc += $p.ProcessId; $changed = $true
    }
  }
}
$desc | ForEach-Object { Get-Process -Id $_ -EA SilentlyContinue } |
  Measure-Object WorkingSet64, PrivateMemorySize64 -Sum
```

## 3. 10 MB 文件读写（Rust 侧）

方法：`cargo test --release --lib perf_read_10mb -- --ignored --nocapture`，生成 10,485,804 字节
的日志文本，测 `read_file`（读 + 编码检测 + 解码）与 `write_file`（编码 + 原子写）。

| 操作 | 耗时 |
|---|---|
| 读 + 检测 + 解码 | **14.1 ms** |
| 编码 + 原子写（临时文件 + rename） | **21.9 ms** |

140 万行的文本 14 ms 完成解码，说明 Rust 侧远不是瓶颈；10 MB 文件真正的成本在
CodeMirror 的 `EditorState` 构建与首屏渲染。这一项**尚未测量**，需要 DevTools Performance
面板或后续引入 tauri-driver / Playwright 自动化后补。

复现：

```bash
cd src-tauri
cargo test --release --lib perf_read_10mb -- --ignored --nocapture
```

## 4. 大文件分级（T12）

方法：`cargo test --release --lib perf_large_file -- --ignored --nocapture` 生成 100 MB 日志文本，
测「首次建行索引」与「区间读取」；端到端用 `scripts/e2e-smoke.ps1` 通过 WebView2 DevTools 协议
（CDP）驱动真实安装版计时。

| 操作 | 耗时 | 备注 |
|---|---|---|
| 100 MB 首次建行索引 | **64.6 ms** | 1,542,024 行，单遍流式扫描 `\n` 偏移 |
| 400 行区间读取（已建索引） | **0.37–0.87 ms** | seek + 读 8 MB 上限 + `encoding_rs` 解码 |
| 35 MB / 500,000 行打开到首屏 | **458 ms** | `performance.now()` 到首屏 400 行渲染，含应用启动与会话恢复 |
| 滚动 200,000 px 后重取窗口 | < 1.5 s 内完成（E2E 断言） | 每次固定 400 行，前端只保留一个窗口 |

结论：L2（20–100 MB）走「Rust 行索引 + 区间读取 + 只读虚拟滚动」后，打开成本与文件大小基本线性
（100 MB 记忆化索引 65 ms），滚动成本取决于单次区间解码（亚毫秒级），与总行数无关。真正的上限在
渲染：前端只渲染 400 行，不随文件增长。

复现：

```powershell
cd src-tauri
cargo test --release --lib perf_large_file -- --ignored --nocapture

# 端到端（需先带远程调试端口启动安装版）
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
Start-Process "$env:LOCALAPPDATA\6byte\6byte.exe"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e-smoke.ps1
```

## 5. 跨文件 grep（T14）

方法：`cargo test --release --lib perf_grep -- --ignored --nocapture`，在临时目录生成 1000 个各 20 行的
日志文件，用模式 `items/500` 搜索。

| 操作 | 耗时 |
|---|---|
| 1000 个文件 grep（2 万行，20 处命中） | **64.5 ms** |

验收线是 2 s，余量约 30×。成本主要在文件读取；跳过二进制与依赖目录后，实际大仓库的扫描量会显著低于
纯文件数 × 平均大小。

复现：

```bash
cd src-tauri
cargo test --release --lib perf_grep -- --ignored --nocapture
```

## 6. 体积

| 产物 | 体积 |
|---|---|
| `dist/assets/index-*.js` | 995.7 KB（gzip 337.8 KB） |
| `dist/assets/index-*.css` | 20.1 KB（gzip 4.2 KB） |
| MSI | 5.70 MB |
| NSIS setup | 4.88 MB |
| 应用 exe（release） | 8.51 MiB |

## 7. 输入延迟（M-02 / T27）

方法：安装版 v0.1.5，用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`
通过 CDP `Input.dispatchKeyEvent` 注入字符 `a`。预览关闭，样本为纯文本（无 Markdown 解析、无 Shiki）。
计时从 `keydown` 捕获到 CodeMirror 把变更写回 DOM，并调用 `getBoundingClientRect()` 强制布局。
每种文档预热 8 次、取样 40 次。这是「按键处理能否放进一帧」的耗时，不是等到下一次绘制的墙钟时间。

测量时间：2026-10-22。机器与上文「环境」相同。

| 场景 | 模式 | P50 | P95 | 最大 |
|---|---|---|---|---|
| 1000 行 / 73 KB | L0，完整装饰（折叠槽在） | 3.1 ms | **5.6 ms** | 7.4 ms |
| 10 MB / 约 14.0 万行 | L1，简化装饰 | 1.6 ms | **3.0 ms** | 4.1 ms |
| 19 MB / 26.6 万行 | L1，简化装饰 | 1.5 ms | **2.7 ms** | 4.2 ms |

三档 P95 都低于 16 ms。L1 比 1000 行的 L0 更快，是因为超过 5 MB 会关掉折叠、括号匹配和语法装饰；
单字符插入走 CodeMirror 的树结构，不会把整篇再扫一遍。

另外两个读数不要和 16 ms 预算直接比：

- 到下一帧 `requestAnimationFrame` 的 P95 是 14.6–15.7 ms，主要是在等帧边界。
- Event Timing「到下一次绘制」报 24–32 ms（8 ms 量化）。同批事件的排队延迟约 0.3–1.9 ms，处理函数本身不到 1.2 ms。

未覆盖：中文输入法、超长单行、大段粘贴。预览更新有 120 ms 防抖，不在单次按键的同步路径上。
10 MB「打开到可滚动」仍未按预算口径单测（见 §8）。

## 8. 未测项与后续

| 项 | 现状 | 计划 |
|---|---|---|
| 10 MB 端到端打开（编辑器模式） | 未测 | 需要把 L1 打开到可滚动的计时从「会话重载 + CDP 重连」里拆出来 |
| 3 文件内存 | 未测（无自动化入口） | 进程树私有内存，打开 3 个文本标签后采样 |
| 冷磁盘冷启动 | 未测 | 发布前在干净机器上复测（T22 发布清单） |
| 文件树首屏 | ≤300 ms（人工，不是 CI 门禁） | 未测 | 先画 300 行，其余点「显示更多」。单层列举上限 2000，不做整树扫描 |

**已知环境问题（不影响用户）**：本机 `cargo clippy` 默认会解析到
`stable-x86_64-pc-windows-gnu` toolchain，而该 toolchain 的 llvm-mingw 链接器缺少 `libgcc`，
导致编译依赖的 build script 失败。临时解法：

```powershell
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
cargo clippy --all-targets -- -D warnings
```

按此方式本机 clippy 已全绿（并因此发现并修复了 `Eol` 的手写 `Default` 实现，改为 `#[derive(Default)]`
+ `#[default]`）。`cargo build` / `cargo test` / `cargo fmt` 不受影响；CI 使用
`dtolnay/rust-toolchain` 固定 stable，无需该变量。