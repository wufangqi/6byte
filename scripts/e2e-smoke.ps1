#requires -version 5.1
<#
.SYNOPSIS
  End-to-end smoke test for the installed app, driven through the WebView2
  DevTools protocol (no UI automation framework needed).

.DESCRIPTION
  Covers the paths that unit tests cannot reach:
    0. reset persisted session/recent/theme, then:
    1-15. large files, mixed EOL, session recovery, watcher, conflicts, grep,
          find & replace, Markdown preview/export/outline, image paste, shiki,
          split divider, recent-file deletion, >100 MB read-only viewer,
    16-19. title bar menus and window controls, theme switching + persistence,
           per-file preview state, Mermaid and KaTeX rendering.

  Prerequisites:
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
    Start-Process "$env:LOCALAPPDATA\6byte\6byte.exe"

  Exit code 0 = all checks passed.

.PARAMETER Port
  DevTools port the WebView2 host listens on (default 9222).

.PARAMETER LogFile
  Large test file used for the viewer check. Created when missing.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e-smoke.ps1
#>
param(
  [int]$Port = 9222,
  [string]$LogFile = (Join-Path $env:TEMP 'ainative-e2e-large.log')
)

$ErrorActionPreference = 'Stop'
$script:Failures = 0

function Assert-True {
  param([bool]$Condition, [string]$Label, [string]$Detail = '')
  if ($Condition) {
    Write-Host "  PASS  $Label" -ForegroundColor Green
  } else {
    $script:Failures++
    Write-Host "  FAIL  $Label $Detail" -ForegroundColor Red
  }
}

function Get-PageTarget {
  $targets = Invoke-RestMethod "http://127.0.0.1:$Port/json/list" -TimeoutSec 5
  $targets | Where-Object { $_.type -eq 'page' -and $_.webSocketDebuggerUrl } | Select-Object -First 1
}

function Connect-Cdp {
  param([string]$Url)
  $socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $socket.ConnectAsync([Uri]$Url, [System.Threading.CancellationToken]::None).Wait(10000) | Out-Null
  $socket
}

function Invoke-CdpEval {
  param($Socket, [string]$Expression)
  $payload = @{
    id = 1
    method = 'Runtime.evaluate'
    params = @{ expression = $Expression; returnByValue = $true; awaitPromise = $true }
  } | ConvertTo-Json -Depth 8 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $Socket.SendAsync(
    [ArraySegment[byte]]::new($bytes),
    [System.Net.WebSockets.WebSocketMessageType]::Text,
    $true,
    [System.Threading.CancellationToken]::None
  ).Wait(10000) | Out-Null

  $buffer = New-Object byte[] 1048576
  $segment = [ArraySegment[byte]]::new($buffer)
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    $result = $Socket.ReceiveAsync($segment, [System.Threading.CancellationToken]::None).Result
    $text = [Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
    try { $message = $text | ConvertFrom-Json } catch { continue }
    if ($message.id -eq 1) { return $message.result.result.value }
  }
  throw 'CDP evaluate timed out'
}

# Send an arbitrary CDP command (e.g. Input.insertText / Input.dispatchKeyEvent)
# and return its raw `result` object.
function Invoke-CdpMethod {
  param($Socket, [string]$Method, [hashtable]$Params = @{})
  $payload = @{
    id = 1
    method = $Method
    params = $Params
  } | ConvertTo-Json -Depth 8 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $Socket.SendAsync(
    [ArraySegment[byte]]::new($bytes),
    [System.Net.WebSockets.WebSocketMessageType]::Text,
    $true,
    [System.Threading.CancellationToken]::None
  ).Wait(10000) | Out-Null

  $buffer = New-Object byte[] 1048576
  $segment = [ArraySegment[byte]]::new($buffer)
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    $received = $Socket.ReceiveAsync($segment, [System.Threading.CancellationToken]::None).Result
    $text = [Text.Encoding]::UTF8.GetString($buffer, 0, $received.Count)
    try { $message = $text | ConvertFrom-Json } catch { continue }
    if ($message.id -eq 1) { return $message.result }
  }
  throw "CDP $Method timed out"
}

function Wait-AppReady {
  param($Socket, [int]$TimeoutSeconds = 30)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $ready = Invoke-CdpEval $Socket "document.querySelector('.app') !== null"
    if ($ready -eq $true) { return }
    Start-Sleep -Milliseconds 300
  }
  throw "WebView2 app did not become ready within $TimeoutSeconds s"
}

function Set-SessionAndReload {
  param([string[]]$Paths, [int]$SettleSeconds = 5)
  $json = ($Paths | ForEach-Object { "'" + $_.Replace('\', '\\') + "'" }) -join ','
  $page = Get-PageTarget
  if (-not $page) { throw "no WebView2 page target on port $Port" }
  $socket = Connect-Cdp $page.webSocketDebuggerUrl
  Invoke-CdpEval $socket "localStorage.setItem('ainative.session', JSON.stringify([$json])); localStorage.setItem('ainative.preview', '0'); localStorage.setItem('ainative.splitPercent', '50'); 'ok'" | Out-Null
  Invoke-CdpEval $socket 'location.reload(); "ok"' | Out-Null
  $socket.Dispose()
  Start-Sleep -Seconds $SettleSeconds
  # The reload replaces the target's execution context, so reconnect.
  $page = Get-PageTarget
  if (-not $page) { throw "WebView2 page target disappeared after reload" }
  $socket = Connect-Cdp $page.webSocketDebuggerUrl
  Wait-AppReady $socket
  Start-Sleep -Milliseconds 800
  $socket
}

try {
  Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 5 | Out-Null
} catch {
  Write-Host "No DevTools endpoint on port $Port." -ForegroundColor Yellow
  Write-Host 'Launch the app with:'
  Write-Host "  `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=$Port'"
  Write-Host "  Start-Process `"`$env:LOCALAPPDATA\6byte\6byte.exe`""
  exit 2
}

# ---------------------------------------------------------------- large file
# --------------------------------------- 0. reset persisted state
# The app restores its last session on launch; a stale session (e.g. files the
# previous run deleted) makes the first steps flaky. Clear it before testing.
Write-Host '[0/22] reset persisted session, recent files, theme and locale' -ForegroundColor DarkCyan
$resetPage = Get-PageTarget
$resetSocket = Connect-Cdp $resetPage.webSocketDebuggerUrl
Wait-AppReady $resetSocket
Invoke-CdpEval $resetSocket "localStorage.setItem('ainative.session', '[]'); localStorage.setItem('ainative.recent', '[]'); localStorage.setItem('ainative.theme', 'dark'); localStorage.setItem('ainative.locale', 'zh'); 'ok'" | Out-Null
Invoke-CdpEval $resetSocket 'location.reload(); "ok"' | Out-Null
$resetSocket.Dispose()
Start-Sleep -Seconds 4

Write-Host '[1/22] large-file staged loading' -ForegroundColor Cyan
if (-not (Test-Path $LogFile)) {
  Write-Host "      creating $LogFile (~35 MB)..."
  $stream = [IO.File]::Create($LogFile)
  $writer = New-Object IO.StreamWriter($stream)
  $stamp = [DateTime]::UtcNow
  for ($i = 0; $i -lt 500000; $i++) {
    $writer.WriteLine(('{0:yyyy-MM-ddTHH:mm:ssZ} INFO request served in {1}ms path=/api/v1/items/{1}' -f $stamp.AddMilliseconds($i), ($i % 250)))
  }
  $writer.Close()
  $stream.Close()
}

$socket = Set-SessionAndReload -Paths @($LogFile)
$probe = @'
(() => ({
  notice: document.querySelector('.viewer__notice')?.textContent?.trim() ?? null,
  lines: document.querySelectorAll('.viewer__line').length,
  first: document.querySelector('.viewer__num')?.textContent ?? null,
  scrollable: (() => {
    const scroller = document.querySelector('.viewer__scroller');
    return scroller ? scroller.scrollHeight > scroller.clientHeight : false;
  })(),
}))()
'@
$before = Invoke-CdpEval $socket ($probe -replace "`r`n", ' ')
Assert-True ($null -ne $before.notice -and $before.notice.Contains('只读')) 'read-only viewer notice' "$($before | ConvertTo-Json -Compress)"
Assert-True ($before.lines -gt 0) 'first window rendered' "lines=$($before.lines)"
Assert-True ($before.scrollable) 'scroll canvas taller than viewport'

$scroll = @'
(async () => {
  const scroller = document.querySelector('.viewer__scroller');
  scroller.scrollTop = 200000;
  scroller.dispatchEvent(new Event('scroll'));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return { first: document.querySelector('.viewer__num')?.textContent ?? null, lines: document.querySelectorAll('.viewer__line').length };
})()
'@
$after = Invoke-CdpEval $socket ($scroll -replace "`r`n", ' ')
Assert-True ($after.first -ne $before.first) 'scroll refetches a new window' "before=$($before.first) after=$($after.first)"
Assert-True ($after.lines -gt 0) 'window still rendered after scroll'
$socket.Dispose()

# ------------------------------------------------- mixed EOL + missing file
Write-Host '[2/22] mixed line endings badge' -ForegroundColor Cyan
$fixture = Join-Path $PSScriptRoot '..\src-tauri\fixtures\mixed-eol.txt'
$missing = Join-Path $PSScriptRoot '..\src-tauri\fixtures\does-not-exist.txt'
$socket = Set-SessionAndReload -Paths @($fixture, $missing)

$mixed = @'
(() => ({
  warnings: [...document.querySelectorAll('.statusbar__warn')].map((node) => node.textContent.trim()),
  banner: document.querySelector('.banner__text')?.textContent?.trim() ?? null,
  session: localStorage.getItem('ainative.session'),
}))()
'@
$mixedResult = Invoke-CdpEval $socket ($mixed -replace "`r`n", ' ')
Assert-True ($mixedResult.warnings -contains '混合换行') 'mixed EOL badge shown' "$($mixedResult.warnings -join ',')"
$socket.Dispose()

Write-Host '[3/22] session restore with a missing path' -ForegroundColor Cyan
Assert-True ($mixedResult.banner -like '*已无法打开*') 'one-off banner for skipped files' "$($mixedResult.banner)"
Assert-True ($mixedResult.session -notlike '*does-not-exist*') 'missing path dropped from session' "$($mixedResult.session)"

# ------------------------------------------- external change (T13 file watch)
Write-Host '[4/22] external change reloads a clean tab' -ForegroundColor Cyan
$watchedFile = Join-Path $env:TEMP 'ainative-e2e-watch.txt'
Set-Content -Path $watchedFile -Value 'before external change' -Encoding UTF8
$socket = Set-SessionAndReload -Paths @($watchedFile)

$readContent = "document.querySelector('.cm-content')?.textContent ?? ''"
$beforeContent = Invoke-CdpEval $socket $readContent
Assert-True ($beforeContent -like '*before external change*') 'watched file opened in editor' "$beforeContent"

Set-Content -Path $watchedFile -Value 'AFTER-EXTERNAL-CHANGE' -Encoding UTF8
Start-Sleep -Seconds 3
$afterContent = Invoke-CdpEval $socket $readContent
Assert-True ($afterContent -like '*AFTER-EXTERNAL-CHANGE*') 'clean tab silently reloaded' "$afterContent"
Assert-True ($afterContent -notlike '*before external change*') 'stale content replaced'
$socket.Dispose()
Remove-Item $watchedFile -ErrorAction SilentlyContinue

# ------------------------------- dirty tab: three-way conflict prompt (T13)
Write-Host '[5/22] dirty tab shows the external-change conflict prompt' -ForegroundColor Cyan
$conflictFile = Join-Path $env:TEMP 'ainative-e2e-conflict.txt'
Set-Content -Path $conflictFile -Value 'base content' -Encoding UTF8
$socket = Set-SessionAndReload -Paths @($conflictFile)

$type = @'
(async () => {
  const editor = document.querySelector('.cm-content');
  if (!editor) return { ok: false };
  editor.focus();
  document.execCommand('insertText', false, 'LOCAL-EDIT');
  await new Promise((resolve) => setTimeout(resolve, 300));
  return {
    ok: true,
    dirty: document.querySelector('.statusbar__item--dirty')?.textContent ?? null,
    text: document.querySelector('.cm-content')?.textContent ?? '',
  };
})()
'@
$typed = Invoke-CdpEval $socket ($type -replace "`r`n", ' ')
Assert-True ($typed.ok) 'editor accepts a local edit' "$($typed | ConvertTo-Json -Compress)"
Assert-True ($null -ne $typed.dirty) 'tab marked dirty' "$($typed.dirty)"

Set-Content -Path $conflictFile -Value 'external change while dirty' -Encoding UTF8
Start-Sleep -Seconds 3

$dialogProbe = @'
(() => ({
  title: document.querySelector('.dialog__title')?.textContent ?? null,
  buttons: [...document.querySelectorAll('.dialog__actions button')].map((b) => b.textContent.trim()),
}))()
'@
$dialog = Invoke-CdpEval $socket ($dialogProbe -replace "`r`n", ' ')
Assert-True ($null -ne $dialog.title -and $dialog.title.Contains('外部修改')) 'conflict dialog shown' "$($dialog.title)"
Assert-True ($dialog.buttons.Count -eq 3) 'three-way choice offered' "$($dialog.buttons -join ' / ')"

$keep = @'
(async () => {
  const button = [...document.querySelectorAll('.dialog__actions button')].find((b) => b.textContent.trim() === '保留我的修改');
  if (!button) return { clicked: false };
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 300));
  return {
    clicked: true,
    dialog: document.querySelector('.dialog') !== null,
    text: document.querySelector('.cm-content')?.textContent ?? '',
  };
})()
'@
$kept = Invoke-CdpEval $socket ($keep -replace "`r`n", ' ')
Assert-True ($kept.clicked -and -not $kept.dialog) 'dialog dismissed after choosing keep' "$($kept | ConvertTo-Json -Compress)"
Assert-True ($kept.text -like '*LOCAL-EDIT*') 'local edit preserved' "$($kept.text)"
$socket.Dispose()
Remove-Item $conflictFile -ErrorAction SilentlyContinue

# ------------------------------------------- cross-file search (T14 grep)
Write-Host '[6/22] cross-file search opens the hit' -ForegroundColor Cyan
$grepDir = Join-Path $env:TEMP 'ainative-e2e-grep'
New-Item -ItemType Directory -Force -Path $grepDir | Out-Null
$grepTarget = Join-Path $grepDir 'target-note.txt'
$grepOther = Join-Path $grepDir 'other-note.txt'
Set-Content -Path $grepTarget -Value "intro line`nhello grep-target world`noutro" -Encoding UTF8
Set-Content -Path $grepOther -Value 'nothing to see' -Encoding UTF8
$socket = Set-SessionAndReload -Paths @($grepTarget)

$openGrep = @'
(async () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { open: document.querySelector('.grep') !== null };
})()
'@
$grepOpened = Invoke-CdpEval $socket ($openGrep -replace "`r`n", ' ')
Assert-True ($grepOpened.open) 'Ctrl+Shift+F opens the search panel'

$search = @'
(async () => {
  const input = document.querySelector('.grep__input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'grep-target');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  document.querySelector('.grep__form').requestSubmit();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return {
    stats: document.querySelector('.grep__stats')?.textContent?.trim() ?? null,
    results: document.querySelectorAll('.grep__result').length,
    firstPath: document.querySelector('.grep__path')?.textContent?.trim() ?? null,
    error: document.querySelector('.grep__error')?.textContent?.trim() ?? null,
  };
})()
'@
$found = Invoke-CdpEval $socket ($search -replace "`r`n", ' ')
Assert-True ($null -ne $found.stats -and $found.results -gt 0) 'grep returned hits' "$($found | ConvertTo-Json -Compress)"
Assert-True ($found.firstPath -like '*target-note.txt') 'first hit points at the target file' "$($found.firstPath)"

$jump = @'
(async () => {
  const hit = document.querySelector('.grep__result');
  if (!hit) return { clicked: false };
  hit.click();
  await new Promise((resolve) => setTimeout(resolve, 800));
  return {
    clicked: true,
    panelClosed: document.querySelector('.grep') === null,
    title: document.querySelector('.tab--active')?.textContent?.trim() ?? null,
    text: document.querySelector('.cm-content')?.textContent ?? '',
  };
})()
'@
$jumped = Invoke-CdpEval $socket ($jump -replace "`r`n", ' ')
Assert-True ($jumped.clicked -and $jumped.panelClosed) 'panel closes after opening a hit' "$($jumped | ConvertTo-Json -Compress)"
Assert-True ($jumped.title -like '*target-note.txt*') 'hit opens the matching file' "$($jumped.title)"
Assert-True ($jumped.text -like '*grep-target*') 'editor shows the matched line' "$($jumped.text)"
$socket.Dispose()
Remove-Item $grepDir -Recurse -Force -ErrorAction SilentlyContinue

# --------------------------------------- find & replace panel (T16)
Write-Host '[7/22] search panel finds and replaces' -ForegroundColor Cyan
$findDir = Join-Path $env:TEMP 'ainative-e2e-find'
New-Item -ItemType Directory -Force -Path $findDir | Out-Null
$findFile = Join-Path $findDir 'find-target.txt'
Set-Content -Path $findFile -Value 'alpha beta gamma' -Encoding UTF8
$socket = Set-SessionAndReload -Paths @($findFile)

$openFind = @'
(async () => {
  const content = document.querySelector('.cm-content');
  content.focus();
  content.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 400));
  return {
    open: document.querySelector('.cm-search') !== null,
    labels: [...document.querySelectorAll('.cm-search button')].map((b) => b.textContent.trim()),
  };
})()
'@
$findOpened = Invoke-CdpEval $socket ($openFind -replace "`r`n", ' ')
Assert-True ($findOpened.open) 'Ctrl+F opens the search panel'
Assert-True ($findOpened.labels -contains '全部替换') 'search panel labels are localized' "$($findOpened.labels -join ' / ')"

$replace = @'
(async () => {
  const findInput = document.querySelector('.cm-search input[name="search"]');
  const replaceInput = document.querySelector('.cm-search input[name="replace"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  // The CodeMirror panel commits the query on `change`, not `input`.
  setter.call(findInput, 'beta');
  findInput.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const matches = document.querySelectorAll('.cm-searchMatch').length;
  setter.call(replaceInput, 'BETA');
  replaceInput.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  document.querySelector('.cm-search button[name="replaceAll"]').click();
  await new Promise((resolve) => setTimeout(resolve, 500));
  return {
    matches,
    text: document.querySelector('.cm-content')?.textContent ?? '',
    dirty: document.querySelector('.statusbar__item--dirty')?.textContent ?? null,
  };
})()
'@
$replaced = Invoke-CdpEval $socket ($replace -replace "`r`n", ' ')
Assert-True ($replaced.matches -gt 0) 'find highlights matches' "$($replaced.matches)"
Assert-True ($replaced.text -clike '*BETA*') 'replace all rewrites the buffer' "$($replaced.text)"
Assert-True ($null -ne $replaced.dirty) 'buffer marked dirty after replace' "$($replaced.dirty)"
$socket.Dispose()
Remove-Item $findDir -Recurse -Force -ErrorAction SilentlyContinue

# --------------------------------------- markdown split preview (T19)
Write-Host '[8/22] markdown split preview renders live' -ForegroundColor Cyan
$previewDir = Join-Path $env:TEMP 'ainative-e2e-preview'
New-Item -ItemType Directory -Force -Path $previewDir | Out-Null
$previewFile = Join-Path $previewDir 'preview-target.md'
$markdown = @'
# Title

hello **world**

```js
const a = 1;
```
'@
Set-Content -Path $previewFile -Value $markdown -Encoding UTF8
$socket = Set-SessionAndReload -Paths @($previewFile)

$toggle = @'
(async () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, shiftKey: true, bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 700));
  return {
    split: document.querySelector('.split') !== null,
    heading: document.querySelector('.markdown-preview h1')?.textContent?.trim() ?? null,
    strong: document.querySelector('.markdown-preview strong')?.textContent?.trim() ?? null,
    code: document.querySelector('.markdown-preview pre code')?.textContent ?? null,
    language: document.querySelector('.markdown-preview pre code')?.className ?? null,
    highlighted: document.querySelector('.markdown-preview pre.shiki') !== null,
  };
})()
'@
$toggled = Invoke-CdpEval $socket ($toggle -replace "`r`n", ' ')
Assert-True ($toggled.split) 'Ctrl+Shift+M opens the split preview'
Assert-True ($toggled.heading -eq 'Title') 'heading is rendered' "$($toggled.heading)"
Assert-True ($toggled.strong -eq 'world') 'inline emphasis is rendered' "$($toggled.strong)"
Assert-True ($toggled.code -like '*const a = 1;*') 'fenced code is rendered' "$($toggled.code)"
Assert-True ($toggled.highlighted -or $toggled.language -like '*language-js*') 'code block is highlighted or keeps its language class' "highlighted=$($toggled.highlighted) language=$($toggled.language)"

$live = @'
(async () => {
  const editor = document.querySelector('.cm-content');
  editor.focus();
  document.execCommand('insertText', false, '\n## Second\n');
  await new Promise((resolve) => setTimeout(resolve, 700));
  return {
    heading: document.querySelector('.markdown-preview h2')?.textContent?.trim() ?? null,
  };
})()
'@
$liveResult = Invoke-CdpEval $socket ($live -replace "`r`n", ' ')
Assert-True ($liveResult.heading -eq 'Second') 'preview updates while typing' "$($liveResult.heading)"
$socket.Dispose()
Remove-Item $previewDir -Recurse -Force -ErrorAction SilentlyContinue

# --------------------------------------- export HTML (T19)
Write-Host '[9/22] preview exports a self-contained HTML file' -ForegroundColor Cyan
$exportDir = Join-Path $env:TEMP 'ainative-e2e-export'
New-Item -ItemType Directory -Force -Path $exportDir | Out-Null
$exportFile = Join-Path $exportDir 'export-target.md'
$exportHtml = Join-Path $exportDir 'export-target.html'
Remove-Item $exportHtml -ErrorAction SilentlyContinue
Set-Content -Path $exportFile -Value "# Export Title`n`nbody text" -Encoding UTF8
$socket = Set-SessionAndReload -Paths @($exportFile)

$doExport = @'
(async () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, shiftKey: true, bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 600));
  const button = document.querySelector('.markdown-preview__export');
  if (!button) return { clicked: false };
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 900));
  return {
    clicked: true,
    banner: document.querySelector('.banner--ok .banner__text')?.textContent?.trim() ?? null,
  };
})()
'@
$exported = Invoke-CdpEval $socket ($doExport -replace "`r`n", ' ')
Assert-True ($exported.clicked) 'export button is available'
Assert-True ($null -ne $exported.banner) 'success banner shown' "$($exported.banner)"
$socket.Dispose()

$htmlText = if (Test-Path $exportHtml) { [IO.File]::ReadAllText($exportHtml, [Text.UTF8Encoding]::new($false)) } else { '' }
Assert-True (Test-Path $exportHtml) 'html file written next to the source'
Assert-True ($htmlText -like '*<h1*Export Title*</h1>*') 'exported html contains the rendered heading'
Assert-True ($htmlText -like '*<title>export-target</title>*') 'exported html has a document title'
Remove-Item $exportDir -Recurse -Force -ErrorAction SilentlyContinue

# --------------------------------------- markdown outline (T19)
Write-Host '[10/22] markdown outline jumps inside the preview' -ForegroundColor Cyan
$outlineDir = Join-Path $env:TEMP 'ainative-e2e-outline'
New-Item -ItemType Directory -Force -Path $outlineDir | Out-Null
$outlineFile = Join-Path $outlineDir 'outline-target.md'
$outlineSource = @'
# One

filler paragraph

## Two

filler paragraph two

### Three

filler paragraph three
'@
# Enough content that the preview actually overflows and can scroll.
$filler = (1..60 | ForEach-Object { "filler line $_" }) -join "`n"
$outlineSource = "# One`n`n$filler`n`n## Two`n`n$filler`n`n### Three`n`n$filler"
Set-Content -Path $outlineFile -Value $outlineSource -Encoding UTF8
$socket = Set-SessionAndReload -Paths @($outlineFile)

$outline = @'
(async () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, shiftKey: true, bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 700));
  const toggle = document.querySelector('.markdown-preview__outline-toggle');
  if (!toggle) return { toggle: false };
  toggle.click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const items = [...document.querySelectorAll('.markdown-preview__outline-item')];
  const last = items.find((item) => item.textContent.trim() === 'Three');
  if (last) last.click();
  await new Promise((resolve) => setTimeout(resolve, 400));
  return {
    toggle: true,
    toggleLabel: toggle.textContent.trim(),
    count: items.length,
    labels: items.map((item) => item.textContent.trim()),
    scrolled: (document.querySelector('.markdown-preview__scroll')?.scrollTop ?? 0) > 0,
  };
})()
'@
$outlineResult = Invoke-CdpEval $socket ($outline -replace "`r`n", ' ')
Assert-True ($outlineResult.toggle -and $outlineResult.toggleLabel -like '*大纲*') 'outline toggle is available' "$($outlineResult.toggleLabel)"
Assert-True ($outlineResult.count -eq 3) 'outline lists all headings' "count=$($outlineResult.count) labels=$($outlineResult.labels -join ',')"
Assert-True ($outlineResult.scrolled) 'clicking an outline item scrolls the preview'
$socket.Dispose()
Remove-Item $outlineDir -Recurse -Force -ErrorAction SilentlyContinue

# --------------------------------------- image paste into assets/ (T19)
Write-Host '[11/22] pasted image is saved, previewed and exported' -ForegroundColor Cyan
$pasteDir = Join-Path $env:TEMP 'ainative-e2e-paste'
New-Item -ItemType Directory -Force -Path $pasteDir | Out-Null
$pasteFile = Join-Path $pasteDir 'paste-target.md'
$pasteHtml = Join-Path $pasteDir 'paste-target.html'
Set-Content -Path $pasteFile -Value "# Paste`n`n" -Encoding UTF8
$socket = Set-SessionAndReload -Paths @($pasteFile)

$paste = @'
(async () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, shiftKey: true, bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 600));
  const editor = document.querySelector('.cm-content');
  editor.focus();
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const file = new File([bytes], 'shot.png', { type: 'image/png' });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const imageSrc = document.querySelector('.markdown-preview img')?.getAttribute('src') ?? null;
  document.querySelector('.markdown-preview__export')?.click();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return {
    text: document.querySelector('.cm-content')?.textContent ?? '',
    banner: document.querySelector('.banner--ok .banner__text')?.textContent?.trim() ?? null,
    imageSrc,
  };
})()
'@
$pasted = Invoke-CdpEval $socket ($paste -replace "`r`n", ' ')
Assert-True ($pasted.text -match '!\[图片\]\(assets/') 'markdown snippet inserted' "$($pasted.text)"
Assert-True ($null -ne $pasted.banner -and ($pasted.banner -like '*已保存图片*' -or $pasted.banner -like '*已导出*')) 'success banner for the pasted image' "$($pasted.banner)"
Assert-True ($null -ne $pasted.imageSrc -and $pasted.imageSrc -like 'data:image/png;base64,*') 'preview inlines the image as a data URI' "$($pasted.imageSrc)"
$socket.Dispose()

$assetFiles = @(Get-ChildItem -Path (Join-Path $pasteDir 'assets') -Filter 'image-*.png' -ErrorAction SilentlyContinue)
Assert-True ($assetFiles.Count -eq 1) 'image bytes written to assets/' "count=$($assetFiles.Count)"
$exportedHtml = if (Test-Path $pasteHtml) { [IO.File]::ReadAllText($pasteHtml, [Text.UTF8Encoding]::new($false)) } else { '' }
Assert-True ($exportedHtml -like '*data:image/png;base64,*') 'exported HTML inlines the image' "$(($exportedHtml.Length)) chars"
Remove-Item $pasteDir -Recurse -Force -ErrorAction SilentlyContinue

# --------------------------------------- shiki code highlighting (T19)
Write-Host '[12/22] code fences are highlighted by shiki' -ForegroundColor Cyan
$highlightDir = Join-Path $env:TEMP 'ainative-e2e-highlight'
New-Item -ItemType Directory -Force -Path $highlightDir | Out-Null
$highlightFile = Join-Path $highlightDir 'highlight-target.md'
$highlightSource = @'
# Code

```js
const answer = 42;
console.log(answer);
```
'@
Set-Content -Path $highlightFile -Value $highlightSource -Encoding UTF8
$socket = Set-SessionAndReload -Paths @($highlightFile)

$highlight = @'
(async () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, shiftKey: true, bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 3500));
  const shiki = document.querySelector('.markdown-preview pre.shiki');
  return {
    shiki: shiki !== null,
    tokens: shiki ? shiki.querySelectorAll('span').length : 0,
    text: shiki?.textContent ?? '',
  };
})()
'@
$highlighted = Invoke-CdpEval $socket ($highlight -replace "`r`n", ' ')
Assert-True ($highlighted.shiki) 'shiki replaces the plain code block'
Assert-True ($highlighted.tokens -gt 0) 'syntax tokens are rendered' "tokens=$($highlighted.tokens)"
$socket.Dispose()
Remove-Item $highlightDir -Recurse -Force -ErrorAction SilentlyContinue

# --------------------------------------- resizable split divider (T19)
Write-Host '[13/22] split divider is draggable' -ForegroundColor Cyan
$splitDir = Join-Path $env:TEMP 'ainative-e2e-split'
New-Item -ItemType Directory -Force -Path $splitDir | Out-Null
$splitFile = Join-Path $splitDir 'split-target.md'
$splitSource = "# Split`n`n" + ((1..40 | ForEach-Object { "para $_" }) -join "`n`n")
Set-Content -Path $splitFile -Value $splitSource -Encoding UTF8
$socket = Set-SessionAndReload -Paths @($splitFile)

$drag = @'
(async () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, shiftKey: true, bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 700));
  const split = document.querySelector('.split');
  const divider = document.querySelector('.split__divider');
  const pane = document.querySelector('.split__pane');
  if (!split || !divider || !pane) return { divider: false };
  const rect = split.getBoundingClientRect();
  const before = pane.getBoundingClientRect().width;
  const startX = rect.left + rect.width * 0.5;
  const targetX = rect.left + rect.width * 0.3;
  divider.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: startX, clientY: rect.top + 120, bubbles: true, pointerId: 1 }));
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: targetX, clientY: rect.top + 120, bubbles: true, pointerId: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: targetX, clientY: rect.top + 120, bubbles: true, pointerId: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = pane.getBoundingClientRect().width;
  divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const reset = pane.getBoundingClientRect().width;
  return {
    divider: true,
    before,
    after,
    reset,
    half: rect.width / 2,
  };
})()
'@
$dragged = Invoke-CdpEval $socket ($drag -replace "`r`n", ' ')
Assert-True ($dragged.divider) 'split divider is present'
Assert-True ($dragged.after -lt $dragged.before - 20) 'dragging left narrows the editor pane' "before=$([math]::Round($dragged.before,0)) after=$([math]::Round($dragged.after,0))"
Assert-True ([math]::Abs($dragged.reset - $dragged.half) -le 4) 'double-click restores the 50/50 split' "reset=$([math]::Round($dragged.reset,0)) half=$([math]::Round($dragged.half,0))"
$socket.Dispose()
Remove-Item $splitDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''

# --------------------------------------- recent files: delete (v0.1.4)
Write-Host '[14/22] recent files can be deleted' -ForegroundColor Cyan
$recentDir = Join-Path $env:TEMP 'ainative-e2e-recent'
New-Item -ItemType Directory -Force -Path $recentDir | Out-Null
$recentA = Join-Path $recentDir 'recent-a.md'
$recentB = Join-Path $recentDir 'recent-b.md'
Set-Content -Path $recentA -Value '# A' -Encoding UTF8
Set-Content -Path $recentB -Value '# B' -Encoding UTF8
$socket = Set-SessionAndReload -Paths @()
$recentJson = "['" + $recentA.Replace('\', '\\') + "','" + $recentB.Replace('\', '\\') + "']"
Invoke-CdpEval $socket "localStorage.setItem('ainative.recent', JSON.stringify($recentJson)); 'ok'" | Out-Null
Invoke-CdpEval $socket 'location.reload(); "ok"' | Out-Null
$socket.Dispose()
Start-Sleep -Seconds 4
$page = Get-PageTarget
$socket = Connect-Cdp $page.webSocketDebuggerUrl

$remove = @'
(async () => {
  const items = () => [...document.querySelectorAll('.welcome__recent-item')];
  const before = items().length;
  const buttons = document.querySelectorAll('.welcome__recent-remove').length;
  items()[0]?.querySelector('.welcome__recent-remove')?.click();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const stored = localStorage.getItem('ainative.recent') ?? '';
  return {
    before,
    buttons,
    after: items().length,
    stillHasRemoved: stored.includes('recent-a.md'),
    stillHasKept: stored.includes('recent-b.md'),
  };
})()
'@
$removed = Invoke-CdpEval $socket ($remove -replace "`r`n", ' ')
Assert-True ($removed.before -eq 2) 'recent list shows both entries' "before=$($removed.before)"
Assert-True ($removed.buttons -eq 2) 'every entry has a delete button' "buttons=$($removed.buttons)"
Assert-True ($removed.after -eq 1) 'clicking delete removes exactly one entry' "after=$($removed.after)"
Assert-True ($removed.stillHasRemoved -eq $false -and $removed.stillHasKept) 'localStorage keeps only the remaining entry' "removedA=$($removed.stillHasRemoved) keptB=$($removed.stillHasKept)"
$socket.Dispose()
Remove-Item $recentDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''

# --------------------------------------- L3 large file >100 MB (M-01)
Write-Host '[15/22] read-only viewer opens a >100 MB file' -ForegroundColor Cyan
$hugeLog = Join-Path $env:TEMP 'ainative-e2e-huge.log'
if (-not (Test-Path $hugeLog)) {
  Write-Host "      creating $hugeLog (~110 MB)..."
  $stream = [IO.File]::Create($hugeLog)
  $writer = New-Object IO.StreamWriter($stream)
  $stamp = [DateTime]::UtcNow
  $line = '{0:yyyy-MM-ddTHH:mm:ssZ} INFO request served in {1}ms path=/api/v1/items/{1}'
  for ($i = 0; $i -lt 1600000; $i++) {
    $writer.WriteLine(($line -f $stamp.AddMilliseconds($i), ($i % 250)))
  }
  $writer.Close()
  $stream.Close()
}

$socket = Set-SessionAndReload -Paths @($hugeLog) -SettleSeconds 6
$huge = @'
(async () => {
  const notice = document.querySelector('.viewer__notice')?.textContent?.trim() ?? null;
  const lines = document.querySelectorAll('.viewer__line').length;
  const scroller = document.querySelector('.viewer__scroller');
  if (scroller) {
    scroller.scrollTop = 300000;
    scroller.dispatchEvent(new Event('scroll'));
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return {
    notice,
    lines,
    first: document.querySelector('.viewer__num')?.textContent ?? null,
    scrolledLines: document.querySelectorAll('.viewer__line').length,
  };
})()
'@
$hugeResult = Invoke-CdpEval $socket ($huge -replace "`r`n", ' ')
Assert-True ($null -ne $hugeResult.notice -and $hugeResult.notice -like '*只读*' -and $hugeResult.notice -like '*MB*') 'L3 file opens in the read-only viewer' "$($hugeResult.notice)"
Assert-True ($hugeResult.lines -gt 0) 'L3 first window rendered' "lines=$($hugeResult.lines)"
Assert-True ($hugeResult.first -ne '1' -and $hugeResult.scrolledLines -gt 0) 'L3 scrolling refetches a range' "first=$($hugeResult.first)"
$socket.Dispose()
Remove-Item $hugeLog -ErrorAction SilentlyContinue

# --------------------------------------- title bar menus (T51)
Write-Host '[16/22] title bar exposes menus, theme items and window controls' -ForegroundColor Cyan
$socket = Set-SessionAndReload -Paths @()
$chrome = @'
(async () => {
  const brand = document.querySelector('.titlebar__brand')?.getAttribute('aria-label') ?? document.querySelector('.titlebar__brand')?.textContent?.trim() ?? null;
  const triggers = [...document.querySelectorAll('.titlebar__trigger')].map((el) => (el.textContent || '').trim());
  const controls = [...document.querySelectorAll('.titlebar__control')].map((el) => el.getAttribute('aria-label'));
  const fileTrigger = [...document.querySelectorAll('.titlebar__trigger')].find((el) => (el.textContent || '').includes('文件'));
  fileTrigger?.click();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const fileItems = [...document.querySelectorAll('.menu--file .menu__item')].map((el) => (el.textContent || '').trim());
  fileTrigger?.click();
  await new Promise((resolve) => setTimeout(resolve, 120));
  return { brand, triggers, controls, fileItems };
})()
'@
$bar = Invoke-CdpEval $socket ($chrome -replace "`r`n", ' ')
Assert-True ($null -ne $bar.brand) 'title bar brand/logo is rendered' "$($bar.brand)"
Assert-True (($bar.triggers -contains '文件') -and ($bar.triggers -contains '视图')) 'file and view menus exist' "$($bar.triggers -join ',')"
Assert-True ($bar.controls.Count -eq 3) 'window controls: minimize/maximize/close' "$($bar.controls -join ',')"
Assert-True (($bar.fileItems -join ' ').Contains('打开文件夹') -and ($bar.fileItems -join ' ').Contains('全部保存')) 'file menu lists folder and save-all actions' "$($bar.fileItems -join ' | ')"

# --------------------------------------- theme switch + persistence (T51)
Write-Host '[17/22] theme switches from the view menu and survives a reload' -ForegroundColor Cyan
$toLight = @'
(async () => {
  const openView = () => {
    const trigger = [...document.querySelectorAll('.titlebar__trigger')].find((el) => (el.textContent || '').includes('视图'));
    trigger?.click();
  };
  openView();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const item = [...document.querySelectorAll('.menu__item')].find((el) => (el.textContent || '').trim() === '浅色');
  item?.click();
  await new Promise((resolve) => setTimeout(resolve, 400));
  return { theme: document.documentElement.getAttribute('data-theme'), stored: localStorage.getItem('ainative.theme') };
})()
'@
$light = Invoke-CdpEval $socket ($toLight -replace "`r`n", ' ')
Assert-True ($light.theme -eq 'light' -and $light.stored -eq 'light') 'view menu applies the light theme' "$($light | ConvertTo-Json -Compress)"
Invoke-CdpEval $socket 'location.reload(); "ok"' | Out-Null
Start-Sleep -Seconds 4
$socket.Dispose()
$page = Get-PageTarget
$socket = Connect-Cdp $page.webSocketDebuggerUrl
Wait-AppReady $socket
$afterReload = Invoke-CdpEval $socket "JSON.stringify({ theme: document.documentElement.getAttribute('data-theme'), stored: localStorage.getItem('ainative.theme') })"
$reloaded = $afterReload | ConvertFrom-Json
Assert-True ($reloaded.theme -eq 'light' -and $reloaded.stored -eq 'light') 'light theme survives an app reload' "$($afterReload)"
$toDark = @'
(async () => {
  const trigger = [...document.querySelectorAll('.titlebar__trigger')].find((el) => (el.textContent || '').includes('视图'));
  trigger?.click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const item = [...document.querySelectorAll('.menu__item')].find((el) => (el.textContent || '').trim() === '深色');
  item?.click();
  await new Promise((resolve) => setTimeout(resolve, 400));
  return { theme: document.documentElement.getAttribute('data-theme'), stored: localStorage.getItem('ainative.theme') };
})()
'@
$dark = Invoke-CdpEval $socket ($toDark -replace "`r`n", ' ')
Assert-True ($dark.theme -eq 'dark' -and $dark.stored -eq 'dark') 'switching back to dark persists' "$($dark | ConvertTo-Json -Compress)"

# --------------------------------------- per-file preview state (T51)
Write-Host '[18/22] preview toggle is remembered per file' -ForegroundColor Cyan
$previewDir = Join-Path $env:TEMP 'ainative-e2e-preview-state'
New-Item -ItemType Directory -Force -Path $previewDir | Out-Null
$previewMd = Join-Path $previewDir 'diagram.md'
$previewTxt = Join-Path $previewDir 'plain.txt'
$mdSource = "# Math`n`nInline `$x^2 + y^2`$ and a diagram:`n`n``````mermaid`ngraph TD; A-->B;`n```````n"
[IO.File]::WriteAllText($previewMd, $mdSource, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($previewTxt, "plain text`n", [Text.UTF8Encoding]::new($false))
$socket = Set-SessionAndReload -Paths @($previewMd, $previewTxt)
$perFile = @'
(async () => {
  const tab = (name) => [...document.querySelectorAll('.tab')].find((el) => (el.textContent || '').includes(name));
  const md = tab('diagram.md');
  const txt = tab('plain.txt');
  md?.click();
  await new Promise((resolve) => setTimeout(resolve, 300));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, shiftKey: true, bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 700));
  const onMd = !!document.querySelector('.markdown-preview');
  txt?.click();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const onTxt = !!document.querySelector('.markdown-preview');
  md?.click();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const backOnMd = !!document.querySelector('.markdown-preview');
  return { onMd, onTxt, backOnMd };
})()
'@
$state = Invoke-CdpEval $socket ($perFile -replace "`r`n", ' ')
Assert-True ($state.onMd) 'preview opens for the markdown tab' "$($state | ConvertTo-Json -Compress)"
Assert-True ($state.onTxt -eq $false) 'switching to a text tab hides the preview' "$($state | ConvertTo-Json -Compress)"
Assert-True ($state.backOnMd) 'returning to the markdown tab restores its preview' "$($state | ConvertTo-Json -Compress)"

# --------------------------------------- mermaid + katex (T51)
Write-Host '[19/22] preview renders KaTeX formulas and Mermaid diagrams' -ForegroundColor Cyan
$render = @'
(async () => {
  const md = [...document.querySelectorAll('.tab')].find((el) => (el.textContent || '').includes('diagram.md'));
  md?.click();
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (!document.querySelector('.markdown-preview')) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, shiftKey: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  let katex = 0;
  let svg = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    katex = document.querySelectorAll('.markdown-preview .katex').length;
    svg = document.querySelectorAll('.markdown-preview svg').length;
    if (katex > 0 && svg > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return { katex, svg };
})()
'@
$rendered = Invoke-CdpEval $socket ($render -replace "`r`n", ' ')
Assert-True ($rendered.katex -gt 0) 'KaTeX rendered the inline formula' "katex=$($rendered.katex)"
Assert-True ($rendered.svg -gt 0) 'Mermaid rendered the diagram as SVG' "svg=$($rendered.svg)"
$socket.Dispose()
Remove-Item $previewDir -Recurse -Force -ErrorAction SilentlyContinue

# --------------------------------------- theme repaint for code + diagrams (T53)
Write-Host '[20/22] light theme repaints highlighted code and Mermaid diagrams' -ForegroundColor Cyan
$themeDir = Join-Path $env:TEMP 'ainative-e2e-theme-repaint'
New-Item -ItemType Directory -Force -Path $themeDir | Out-Null
$themeFile = Join-Path $themeDir 'theme-demo.md'
$themeSource = @'
# Theme demo

Inline math: $a^2 + b^2$

```ts
const answer: number = 42;
console.log(answer);
```

```mermaid
graph LR; A-->B;
```
'@
[IO.File]::WriteAllText($themeFile, $themeSource.Replace("`r`n", "`n"), [Text.UTF8Encoding]::new($false))
$socket = Set-SessionAndReload -Paths @($themeFile)
$repaint = @'
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, shiftKey: true, bubbles: true }));
  const readState = () => {
    const pre = document.querySelector('.markdown-preview pre.shiki');
    const diagramStyle = document.querySelector('.markdown-preview .mermaid-diagram svg style');
    return {
      bg: pre ? getComputedStyle(pre).backgroundColor : null,
      diagramStyle: diagramStyle?.textContent ?? null,
      diagrams: document.querySelectorAll('.markdown-preview .mermaid-diagram svg').length,
      katex: document.querySelectorAll('.markdown-preview .katex').length,
    };
  };
  let dark = readState();
  for (let attempt = 0; attempt < 25; attempt++) {
    dark = readState();
    if (dark.bg && dark.diagramStyle) break;
    await sleep(400);
  }
  const trigger = [...document.querySelectorAll('.titlebar__trigger')].find((el) => (el.textContent || '').includes('视图'));
  trigger?.click();
  await sleep(200);
  [...document.querySelectorAll('.menu__item')].find((el) => (el.textContent || '').trim() === '浅色')?.click();
  await sleep(400);
  let light = readState();
  for (let attempt = 0; attempt < 25; attempt++) {
    light = readState();
    if (light.bg && light.diagramStyle && light.bg !== dark.bg) break;
    await sleep(400);
  }
  return { dark, light, styleChanged: dark.diagramStyle !== light.diagramStyle };
})()
'@
$painted = Invoke-CdpEval $socket ($repaint -replace "`r`n", ' ')
$darkBg = $painted.dark.bg
$lightBg = $painted.light.bg
Assert-True ($null -ne $darkBg -and $null -ne $lightBg -and $darkBg -ne $lightBg) 'highlighted code repaints for the light theme' "dark=$darkBg light=$lightBg"
$rgb = [regex]::Matches($lightBg, '\d+') | ForEach-Object { [int]$_.Value }
$luminance = if ($rgb.Count -ge 3) { ($rgb[0] + $rgb[1] + $rgb[2]) / 3 } else { 0 }
Assert-True ($luminance -gt 150) 'light theme uses a light code background' "rgb=$($rgb -join ',') luminance=$luminance"
Assert-True ($painted.light.diagrams -gt 0 -and $painted.light.katex -gt 0) 'diagram and formula survive the theme switch' "diagrams=$($painted.light.diagrams) katex=$($painted.light.katex)"
Assert-True ($painted.styleChanged) 'Mermaid re-renders with the light palette' "changed=$($painted.styleChanged)"
$restoreDark = @'
(async () => {
  const trigger = [...document.querySelectorAll('.titlebar__trigger')].find((el) => (el.textContent || '').includes('视图'));
  trigger?.click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  [...document.querySelectorAll('.menu__item')].find((el) => (el.textContent || '').trim() === '深色')?.click();
  await new Promise((resolve) => setTimeout(resolve, 300));
  return document.documentElement.getAttribute('data-theme');
})()
'@
$restored = Invoke-CdpEval $socket ($restoreDark -replace "`r`n", ' ')
Assert-True ($restored -eq 'dark') 'dark theme restored for the next run' "$restored"
$socket.Dispose()
Remove-Item $themeDir -Recurse -Force -ErrorAction SilentlyContinue

# --------------------------------------- UI language switch (M-10)
Write-Host '[21/22] interface language switches to English and persists' -ForegroundColor Cyan
$langDir = Join-Path $env:TEMP 'ainative-e2e-locale'
New-Item -ItemType Directory -Force -Path $langDir | Out-Null
$langFile = Join-Path $langDir 'greeting.md'
[IO.File]::WriteAllText($langFile, "# Hello`n`nLanguage check.`n", [Text.UTF8Encoding]::new($false))
$socket = Set-SessionAndReload -Paths @($langFile)
$lang = @'
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const trigger = (name) =>
    [...document.querySelectorAll('.titlebar__trigger')].find((el) =>
      (el.textContent || '').includes(name)
    );
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, shiftKey: true, bubbles: true }));
  await sleep(900);
  const readState = () => ({
    locale: localStorage.getItem('ainative.locale'),
    lang: document.documentElement.lang,
    triggers: [...document.querySelectorAll('.titlebar__trigger')].map((el) =>
      (el.textContent || '').trim()
    ),
    statusbar: document.querySelector('.statusbar')?.textContent ?? '',
    newTabTitle: document.querySelector('.tabbar__new')?.getAttribute('title') ?? null,
    previewExport: document.querySelector('.markdown-preview__export')?.textContent?.trim() ?? null,
    outline: document.querySelector('.markdown-preview__outline-toggle')?.textContent?.trim() ?? null,
  });
  trigger('视图')?.click();
  await sleep(200);
  [...document.querySelectorAll('.menu__item')]
    .find((el) => (el.textContent || '').trim() === 'English')
    ?.click();
  await sleep(500);
  return readState();
})()
'@
$english = Invoke-CdpEval $socket ($lang -replace "`r`n", ' ')
Assert-True ($english.locale -eq 'en' -and $english.lang -eq 'en') 'language choice is stored and applied' "locale=$($english.locale) lang=$($english.lang)"
Assert-True (($english.triggers -contains 'File') -and ($english.triggers -contains 'View')) 'title bar menus switch to English' "$($english.triggers -join ',')"
Assert-True ($english.statusbar.Contains('Saved') -or $english.statusbar.Contains('Unsaved') -or $english.statusbar.Contains('Ready')) 'status bar switches to English' "$($english.statusbar.Trim())"
Assert-True ($english.newTabTitle -eq 'New (Ctrl+N)') 'tab bar tooltips switch to English' "$($english.newTabTitle)"
Assert-True ($english.previewExport -eq 'Export HTML') 'preview pane switches to English' "$($english.previewExport)"
Assert-True ($english.outline -eq 'Outline (1)') 'outline counter switches to English' "$($english.outline)"
Invoke-CdpEval $socket 'location.reload(); "ok"' | Out-Null
Start-Sleep -Seconds 4
$socket.Dispose()
$page = Get-PageTarget
$socket = Connect-Cdp $page.webSocketDebuggerUrl
Wait-AppReady $socket
$afterLangReload = Invoke-CdpEval $socket "JSON.stringify({ locale: localStorage.getItem('ainative.locale'), triggers: [...document.querySelectorAll('.titlebar__trigger')].map((el) => (el.textContent || '').trim()), status: document.querySelector('.statusbar')?.textContent ?? '' })"
$reloadedLang = $afterLangReload | ConvertFrom-Json
Assert-True (($reloadedLang.locale -eq 'en') -and ($reloadedLang.triggers -contains 'File')) 'English survives an app reload' "$afterLangReload"
$backToZh = @'
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const trigger = (name) =>
    [...document.querySelectorAll('.titlebar__trigger')].find((el) =>
      (el.textContent || '').includes(name)
    );
  trigger('View')?.click();
  await sleep(200);
  [...document.querySelectorAll('.menu__item')]
    .find((el) => (el.textContent || '').trim() === '中文')
    ?.click();
  await sleep(500);
  return {
    locale: localStorage.getItem('ainative.locale'),
    triggers: [...document.querySelectorAll('.titlebar__trigger')].map((el) =>
      (el.textContent || '').trim()
    ),
    status: document.querySelector('.statusbar')?.textContent ?? '',
  };
})()
'@
$zh = Invoke-CdpEval $socket ($backToZh -replace "`r`n", ' ')
Assert-True (($zh.locale -eq 'zh') -and ($zh.triggers -contains '文件')) 'switching back to Chinese works' "$($zh | ConvertTo-Json -Compress)"
$socket.Dispose()
Remove-Item $langDir -Recurse -Force -ErrorAction SilentlyContinue

# --------------------------------------- 22. undo history across tabs and preview (M-06)
Write-Host '[22/22] undo history survives tab switches and preview toggles' -ForegroundColor Cyan
$undoDir = Join-Path $env:TEMP 'ainative-e2e-undo'
New-Item -ItemType Directory -Force -Path $undoDir | Out-Null
$undoA = Join-Path $undoDir 'undo-a.md'
$undoB = Join-Path $undoDir 'undo-b.md'
[IO.File]::WriteAllText($undoA, "# Alpha`n`nfirst line`n", [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($undoB, "# Beta`n`nsecond line`n", [Text.UTF8Encoding]::new($false))
$socket = Set-SessionAndReload -Paths @($undoA, $undoB)
$switchToA = @'
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const tab = (name) =>
    [...document.querySelectorAll('.tab')].find((el) => (el.textContent || '').includes(name));
  tab('undo-a.md')?.click();
  await sleep(400);
  return (document.querySelector('.cm-content')?.innerText ?? '').includes('first line');
})()
'@
$onA = Invoke-CdpEval $socket ($switchToA -replace "`r`n", ' ')
Assert-True ($onA -eq $true) 'both files open and the first tab can be activated' "$onA"
Invoke-CdpEval $socket "document.querySelector('.cm-content')?.focus(); true" | Out-Null
$null = Invoke-CdpMethod $socket 'Input.insertText' @{ text = 'UNDO-TAB ' }
Start-Sleep -Milliseconds 300
$typed = Invoke-CdpEval $socket "(document.querySelector('.cm-content')?.innerText ?? '').includes('UNDO-TAB')"
Assert-True ($typed -eq $true) 'typing through CDP reaches the editor' "$typed"
$switchAwayAndBack = @'
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const tab = (name) =>
    [...document.querySelectorAll('.tab')].find((el) => (el.textContent || '').includes(name));
  tab('undo-b.md')?.click();
  await sleep(300);
  tab('undo-a.md')?.click();
  await sleep(400);
  return { text: document.querySelector('.cm-content')?.innerText ?? '' };
})()
'@
$backOnA = Invoke-CdpEval $socket ($switchAwayAndBack -replace "`r`n", ' ')
Assert-True ($backOnA.text.Contains('UNDO-TAB')) 'the edited document comes back after a tab switch' "$($backOnA.text.Substring(0, [Math]::Min(60, $backOnA.text.Length)))"
$null = Invoke-CdpMethod $socket 'Input.dispatchKeyEvent' @{ type = 'rawKeyDown'; modifiers = 2; key = 'z'; code = 'KeyZ'; windowsVirtualKeyCode = 90; nativeVirtualKeyCode = 90 }
$null = Invoke-CdpMethod $socket 'Input.dispatchKeyEvent' @{ type = 'keyUp'; modifiers = 2; key = 'z'; code = 'KeyZ'; windowsVirtualKeyCode = 90; nativeVirtualKeyCode = 90 }
Start-Sleep -Milliseconds 400
$afterUndo = Invoke-CdpEval $socket "document.querySelector('.cm-content')?.innerText ?? ''"
Assert-True (-not $afterUndo.Contains('UNDO-TAB')) 'undo still works after switching tabs (history survived)' "$($afterUndo.Substring(0, [Math]::Min(60, $afterUndo.Length)))"
$openPreview = @'
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const before = document.querySelector('.cm-content');
  [...document.querySelectorAll('.statusbar button')]
    .find((el) => (el.textContent || '').includes('预览'))
    ?.click();
  await sleep(900);
  return { sameEditor: before === document.querySelector('.cm-content'), preview: document.querySelector('.markdown-preview') !== null };
})()
'@
$toggled = Invoke-CdpEval $socket ($openPreview -replace "`r`n", ' ')
Assert-True ($toggled.preview -eq $true) 'preview opens' "$($toggled | ConvertTo-Json -Compress)"
Assert-True ($toggled.sameEditor -eq $true) 'opening the preview keeps the editor mounted (no remount)' "$($toggled | ConvertTo-Json -Compress)"
Invoke-CdpEval $socket "document.querySelector('.cm-content')?.focus(); true" | Out-Null
$null = Invoke-CdpMethod $socket 'Input.insertText' @{ text = 'UNDO-PREVIEW ' }
Start-Sleep -Milliseconds 300
$previewTyped = Invoke-CdpEval $socket "document.querySelector('.cm-content')?.innerText ?? ''"
$null = Invoke-CdpMethod $socket 'Input.dispatchKeyEvent' @{ type = 'rawKeyDown'; modifiers = 2; key = 'z'; code = 'KeyZ'; windowsVirtualKeyCode = 90; nativeVirtualKeyCode = 90 }
$null = Invoke-CdpMethod $socket 'Input.dispatchKeyEvent' @{ type = 'keyUp'; modifiers = 2; key = 'z'; code = 'KeyZ'; windowsVirtualKeyCode = 90; nativeVirtualKeyCode = 90 }
Start-Sleep -Milliseconds 400
$previewUndo = Invoke-CdpEval $socket "document.querySelector('.cm-content')?.innerText ?? ''"
Assert-True ($previewTyped.Contains('UNDO-PREVIEW') -and -not $previewUndo.Contains('UNDO-PREVIEW')) 'undo still works after opening the preview (history survived)' "typed=$($previewTyped.Contains('UNDO-PREVIEW')) undone=$(-not $previewUndo.Contains('UNDO-PREVIEW'))"
$socket.Dispose()
Remove-Item $undoDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
if ($script:Failures -eq 0) {
  Write-Host 'E2E smoke: all checks passed.' -ForegroundColor Green
  exit 0
}
Write-Host "E2E smoke: $($script:Failures) check(s) failed." -ForegroundColor Red
exit 1