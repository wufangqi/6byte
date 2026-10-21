#requires -version 5.1
<#
.SYNOPSIS
  End-to-end smoke test for the installed app, driven through the WebView2
  DevTools protocol (no UI automation framework needed).

.DESCRIPTION
  Covers the paths that unit tests cannot reach:
    1. large-file staged loading (read-only viewer + scroll refetch),
    2. mixed line endings badge,
    3. session restore with a missing file (one-off banner + session cleanup),
    4. external change silently reloading a clean tab,
    5. external change on a dirty tab showing the three-way conflict prompt,
    6. cross-file search (Ctrl+Shift+F) opening a hit.

  Prerequisites:
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
    Start-Process "$env:LOCALAPPDATA\AI Native Editor\ai-native-editor.exe"

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

function Set-SessionAndReload {
  param([string[]]$Paths, [int]$SettleSeconds = 5)
  $json = ($Paths | ForEach-Object { "'" + $_.Replace('\', '\\') + "'" }) -join ','
  $page = Get-PageTarget
  if (-not $page) { throw "no WebView2 page target on port $Port" }
  $socket = Connect-Cdp $page.webSocketDebuggerUrl
  Invoke-CdpEval $socket "localStorage.setItem('ainative.session', JSON.stringify([$json])); localStorage.setItem('ainative.preview', '0'); 'ok'" | Out-Null
  Invoke-CdpEval $socket 'location.reload(); "ok"' | Out-Null
  $socket.Dispose()
  Start-Sleep -Seconds $SettleSeconds
  # The reload replaces the target's execution context, so reconnect.
  $page = Get-PageTarget
  if (-not $page) { throw "WebView2 page target disappeared after reload" }
  Connect-Cdp $page.webSocketDebuggerUrl
}

try {
  Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 5 | Out-Null
} catch {
  Write-Host "No DevTools endpoint on port $Port." -ForegroundColor Yellow
  Write-Host 'Launch the app with:'
  Write-Host "  `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=$Port'"
  Write-Host "  Start-Process `"`$env:LOCALAPPDATA\AI Native Editor\ai-native-editor.exe`""
  exit 2
}

# ---------------------------------------------------------------- large file
Write-Host '[1/12] large-file staged loading' -ForegroundColor Cyan
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
Write-Host '[2/12] mixed line endings badge' -ForegroundColor Cyan
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

Write-Host '[3/12] session restore with a missing path' -ForegroundColor Cyan
Assert-True ($mixedResult.banner -like '*已无法打开*') 'one-off banner for skipped files' "$($mixedResult.banner)"
Assert-True ($mixedResult.session -notlike '*does-not-exist*') 'missing path dropped from session' "$($mixedResult.session)"

# ------------------------------------------- external change (T13 file watch)
Write-Host '[4/12] external change reloads a clean tab' -ForegroundColor Cyan
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
Write-Host '[5/12] dirty tab shows the external-change conflict prompt' -ForegroundColor Cyan
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
Write-Host '[6/12] cross-file search opens the hit' -ForegroundColor Cyan
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
Write-Host '[7/12] search panel finds and replaces' -ForegroundColor Cyan
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
Write-Host '[8/12] markdown split preview renders live' -ForegroundColor Cyan
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
Write-Host '[9/12] preview exports a self-contained HTML file' -ForegroundColor Cyan
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
Write-Host '[10/12] markdown outline jumps inside the preview' -ForegroundColor Cyan
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
Write-Host '[11/12] pasted image is saved and previewed' -ForegroundColor Cyan
$pasteDir = Join-Path $env:TEMP 'ainative-e2e-paste'
New-Item -ItemType Directory -Force -Path $pasteDir | Out-Null
$pasteFile = Join-Path $pasteDir 'paste-target.md'
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
  return {
    text: document.querySelector('.cm-content')?.textContent ?? '',
    banner: document.querySelector('.banner--ok .banner__text')?.textContent?.trim() ?? null,
    imageSrc: document.querySelector('.markdown-preview img')?.getAttribute('src') ?? null,
  };
})()
'@
$pasted = Invoke-CdpEval $socket ($paste -replace "`r`n", ' ')
Assert-True ($pasted.text -match '!\[图片\]\(assets/') 'markdown snippet inserted' "$($pasted.text)"
Assert-True ($null -ne $pasted.banner -and $pasted.banner -like '*已保存图片*') 'success banner for the pasted image' "$($pasted.banner)"
Assert-True ($null -ne $pasted.imageSrc -and $pasted.imageSrc -like '*asset*') 'preview loads the image via the asset protocol' "$($pasted.imageSrc)"
$socket.Dispose()

$assetFiles = @(Get-ChildItem -Path (Join-Path $pasteDir 'assets') -Filter 'image-*.png' -ErrorAction SilentlyContinue)
Assert-True ($assetFiles.Count -eq 1) 'image bytes written to assets/' "count=$($assetFiles.Count)"
Remove-Item $pasteDir -Recurse -Force -ErrorAction SilentlyContinue

# --------------------------------------- shiki code highlighting (T19)
Write-Host '[12/12] code fences are highlighted by shiki' -ForegroundColor Cyan
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

Write-Host ''
if ($script:Failures -eq 0) {
  Write-Host 'E2E smoke: all checks passed.' -ForegroundColor Green
  exit 0
}
Write-Host "E2E smoke: $($script:Failures) check(s) failed." -ForegroundColor Red
exit 1