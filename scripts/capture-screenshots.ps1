#requires -version 5.1
<#
.SYNOPSIS
  Capture README screenshots from the installed app through the WebView2 DevTools
  protocol (no UI automation framework).

.DESCRIPTION
  Produces four PNGs under docs/assets/:
    welcome.png          empty workspace
    editor-preview.png   markdown editor + split preview with syntax highlighting
    grep.png             cross-file search with results
    large-file.png       read-only large-file viewer

  Prerequisites:
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
    Start-Process "$env:LOCALAPPDATA\6byte\6byte.exe"

.PARAMETER Port
  DevTools port (default 9222).

.PARAMETER OutDir
  Output directory (default docs/assets next to this script).
#>
param(
  [int]$Port = 9222,
  [string]$OutDir = (Join-Path $PSScriptRoot '..\docs\assets')
)

$ErrorActionPreference = 'Stop'
$OutDir = [IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

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

function Invoke-Cdp {
  param($Socket, [string]$Method, [hashtable]$Params = @{})
  $payload = @{ id = 1; method = $Method; params = $Params } | ConvertTo-Json -Depth 6 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $Socket.SendAsync(
    [ArraySegment[byte]]::new($bytes),
    [System.Net.WebSockets.WebSocketMessageType]::Text,
    $true,
    [System.Threading.CancellationToken]::None
  ).Wait(10000) | Out-Null

  $buffer = New-Object byte[] 1048576
  $segment = [ArraySegment[byte]]::new($buffer)
  $pending = New-Object IO.MemoryStream
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    $result = $Socket.ReceiveAsync($segment, [System.Threading.CancellationToken]::None).Result
    $pending.Write($buffer, 0, $result.Count)
    if (-not $result.EndOfMessage) { continue }

    # WebSocket frames can split large payloads (screenshots are base64 PNGs);
    # only parse once the whole message has arrived.
    $text = [Text.Encoding]::UTF8.GetString($pending.ToArray())
    $pending.SetLength(0) | Out-Null
    try { $message = $text | ConvertFrom-Json } catch { continue }
    if ($message.id -eq 1) { return $message.result }
  }
  throw "CDP call timed out: $Method"
}

function Eval-Js {
  param($Socket, [string]$Expression)
  $result = Invoke-Cdp $Socket 'Runtime.evaluate' @{
    expression = $Expression
    returnByValue = $true
    awaitPromise = $true
  }
  return $result.result.value
}

function Set-Session {
  param($Socket, [string[]]$Paths)
  $quoted = ($Paths | ForEach-Object { "'" + $_.Replace('\', '\\') + "'" }) -join ','
  Eval-Js $Socket "localStorage.setItem('ainative.session', JSON.stringify([$quoted])); localStorage.setItem('ainative.preview', '0'); 'ok'" | Out-Null
  Eval-Js $Socket 'location.reload(); "ok"' | Out-Null
}

function Save-Screenshot {
  param($Socket, [string]$Path)
  $result = Invoke-Cdp $Socket 'Page.captureScreenshot' @{ format = 'png' }
  [IO.File]::WriteAllBytes($Path, [Convert]::FromBase64String($result.data))
  Write-Host "  saved $Path" -ForegroundColor DarkGray
}

try {
  Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 5 | Out-Null
} catch {
  Write-Host "No DevTools endpoint on port $Port." -ForegroundColor Yellow
  Write-Host 'Launch the app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=''--remote-debugging-port=9222'' first.'
  exit 2
}

# --- 1. welcome -------------------------------------------------------------
$page = Get-PageTarget
$socket = Connect-Cdp $page.webSocketDebuggerUrl
Set-Session $socket @()
# Seed a couple of recent files so the screenshot shows the delete controls.
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$demoRecent = @((Join-Path $repoRoot 'README.md'), (Join-Path $repoRoot 'CHANGELOG.md'))
$recentJson = ($demoRecent | ForEach-Object { "'" + $_.Replace('\', '\\') + "'" }) -join ','
Eval-Js $socket "localStorage.setItem('ainative.recent', JSON.stringify([$recentJson])); 'ok'" | Out-Null
Eval-Js $socket 'location.reload(); "ok"' | Out-Null
$socket.Dispose()
Start-Sleep -Seconds 4
$page = Get-PageTarget
$socket = Connect-Cdp $page.webSocketDebuggerUrl
Save-Screenshot $socket (Join-Path $OutDir 'welcome.png')

# --- 2. editor + preview ----------------------------------------------------
$demoDir = Join-Path $env:TEMP 'ainative-readme-demo'
New-Item -ItemType Directory -Force -Path $demoDir | Out-Null
$demoFile = Join-Path $demoDir 'welcome.md'
$demo = @'
# aneditor

轻量、跨平台、数据留在本机的文本工作台。

## 已支持

- 编码自动识别与**原样回写**（UTF-8 / GBK / UTF-16）
- 大文件只读预览（20–100 MB）
- 文件监听与外部修改三选一

```ts
const editor = createEditor({ readOnly: false });
console.log(editor.version);
```
'@
Set-Content -Path $demoFile -Value $demo -Encoding UTF8
Set-Session $socket @($demoFile)
$socket.Dispose()
Start-Sleep -Seconds 4
$page = Get-PageTarget
$socket = Connect-Cdp $page.webSocketDebuggerUrl
Eval-Js $socket 'window.dispatchEvent(new KeyboardEvent("keydown", { key: "m", ctrlKey: true, shiftKey: true, bubbles: true })); "ok"' | Out-Null
Start-Sleep -Seconds 3
Save-Screenshot $socket (Join-Path $OutDir 'editor-preview.png')

# --- 3. cross-file search ---------------------------------------------------
Eval-Js $socket 'window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, shiftKey: true, bubbles: true })); "ok"' | Out-Null
Start-Sleep -Milliseconds 500
Eval-Js $socket @'
(() => {
  const input = document.querySelector('.grep__input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, '编码|editor');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('.grep__form').requestSubmit();
  return 'ok';
})()
'@ | Out-Null
Start-Sleep -Seconds 2
Save-Screenshot $socket (Join-Path $OutDir 'grep.png')
$socket.Dispose()

# --- 4. large-file viewer ---------------------------------------------------
$logFile = Join-Path $env:TEMP 'ainative-readme-large.log'
if (-not (Test-Path $logFile)) {
  $stream = [IO.File]::Create($logFile)
  $writer = New-Object IO.StreamWriter($stream)
  $stamp = [DateTime]::UtcNow
  for ($i = 0; $i -lt 200000; $i++) {
    $writer.WriteLine(('{0:yyyy-MM-ddTHH:mm:ssZ} INFO request served in {1}ms path=/api/v1/items/{1}' -f $stamp.AddMilliseconds($i), ($i % 250)))
  }
  $writer.Close()
  $stream.Close()
}
$page = Get-PageTarget
$socket = Connect-Cdp $page.webSocketDebuggerUrl
Set-Session $socket @($logFile)
$socket.Dispose()
Start-Sleep -Seconds 5
$page = Get-PageTarget
$socket = Connect-Cdp $page.webSocketDebuggerUrl
Save-Screenshot $socket (Join-Path $OutDir 'large-file.png')
$socket.Dispose()

Write-Host 'Screenshots captured.' -ForegroundColor Green