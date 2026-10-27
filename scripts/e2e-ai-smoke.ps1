#requires -version 5.1
<#
.SYNOPSIS
  AI smoke test for an installed debug-enabled 6byte build.

.DESCRIPTION
  Starts a local OpenAI-compatible SSE mock, then checks the complete trusted
  rewrite path and the native read-only tool-call path. It never calls a cloud
  model or needs a key. The script refuses to reload an app with dirty tabs and
  restores its localStorage state before exiting.

.EXAMPLE
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
  Start-Process "$env:LOCALAPPDATA\6byte\6byte.exe"
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e-ai-smoke.ps1
#>
param(
  [int]$Port = 9222,
  [int]$MockPort = 11435
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
    if ($message.id -eq 1) {
      if ($message.error) { throw "CDP evaluate failed: $($message.error.message)" }
      if ($message.result.exceptionDetails) {
        $detail = $message.result.exceptionDetails.exception.description
        if (-not $detail) { $detail = $message.result.exceptionDetails.text }
        throw "Page evaluation failed: $detail"
      }
      return $message.result.result.value
    }
  }
  throw 'CDP evaluate timed out'
}

function Invoke-CdpMethod {
  param($Socket, [string]$Method, [hashtable]$Params = @{})
  $payload = @{ id = 1; method = $Method; params = $Params } | ConvertTo-Json -Depth 8 -Compress
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
    if ($message.id -eq 1) { return $message.result }
  }
  throw "CDP $Method timed out"
}

function Wait-For {
  param($Socket, [string]$Expression, [int]$Seconds = 10)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if ((Invoke-CdpEval $Socket $Expression) -eq $true) { return $true }
    Start-Sleep -Milliseconds 200
  }
  return $false
}

function Send-CtrlKey {
  param($Socket, [string]$Key, [int]$VirtualKey)
  $down = @{
    type = 'rawKeyDown'; modifiers = 2; key = $Key; code = "Key$($Key.ToUpper())"
    windowsVirtualKeyCode = $VirtualKey; nativeVirtualKeyCode = $VirtualKey
  }
  $up = @{
    type = 'keyUp'; modifiers = 2; key = $Key; code = "Key$($Key.ToUpper())"
    windowsVirtualKeyCode = $VirtualKey; nativeVirtualKeyCode = $VirtualKey
  }
  Invoke-CdpMethod $Socket 'Input.dispatchKeyEvent' $down | Out-Null
  Invoke-CdpMethod $Socket 'Input.dispatchKeyEvent' $up | Out-Null
}

$mock = $null
$socket = $null
$storageSnapshot = $null
$storageChanged = $false
$fixtureDir = Join-Path $env:TEMP 'ainative-e2e-ai'
try {
  $node = Get-Command node -ErrorAction Stop
  $mockScript = Join-Path $PSScriptRoot 'e2e-ai-mock.mjs'
  $mock = Start-Process -FilePath $node.Source -ArgumentList @($mockScript, $MockPort) -PassThru -WindowStyle Hidden
  $mockReady = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      if ((Invoke-RestMethod "http://127.0.0.1:$MockPort/health" -TimeoutSec 1).ok) {
        $mockReady = $true
        break
      }
    } catch {
      Start-Sleep -Milliseconds 200
    }
  }
  if (-not $mockReady) { throw 'AI mock did not start.' }

  try {
    Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 5 | Out-Null
  } catch {
    throw "No DevTools endpoint on port $Port. Start the app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS."
  }

  New-Item -ItemType Directory -Force -Path $fixtureDir | Out-Null
  $fixture = Join-Path $fixtureDir 'e2e-ai.txt'
  [IO.File]::WriteAllText($fixture, "original text`n", [Text.UTF8Encoding]::new($false))
  $catalog = @{
    activeProviderId = 'e2e'
    activeModelId = 'mock'
    providers = @(
      @{
        id = 'e2e'
        name = 'E2E mock'
        baseUrl = "http://127.0.0.1:$MockPort/v1"
        models = @(@{ id = 'mock'; name = 'mock'; model = 'mock' })
      }
    )
  } | ConvertTo-Json -Depth 8 -Compress
  $rootState = @{ version = 1; rootPath = $fixtureDir } | ConvertTo-Json -Compress
  $session = "[$(ConvertTo-Json -InputObject $fixture -Compress)]"
  $catalogJs = ConvertTo-Json -InputObject $catalog -Compress
  $rootJs = ConvertTo-Json -InputObject $rootState -Compress
  $sessionJs = ConvertTo-Json -InputObject $session -Compress

  $page = Get-PageTarget
  if (-not $page) { throw 'No WebView2 page target.' }
  $socket = Connect-Cdp $page.webSocketDebuggerUrl
  if (Invoke-CdpEval $socket "document.querySelector('.tab__dot') !== null") {
    throw 'Refusing to run AI E2E while the app has unsaved tabs. Save or close them first.'
  }
  $snapshotScript = @'
JSON.stringify(Object.fromEntries(
  Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((key) => key !== null)
    .map((key) => [key, localStorage.getItem(key)])
))
'@
  $storageSnapshot = Invoke-CdpEval $socket ($snapshotScript -replace "`r`n", ' ')
  $setup = @"
localStorage.setItem('ainative.locale', 'en');
localStorage.setItem('ainative.ai', $catalogJs);
localStorage.setItem('ainative.workspace', $rootJs);
localStorage.setItem('ainative.session', $sessionJs);
location.reload();
'ok'
"@
  Invoke-CdpEval $socket ($setup -replace "`r`n", ' ') | Out-Null
  $storageChanged = $true
  $socket.Dispose()
  Start-Sleep -Seconds 3
  $page = Get-PageTarget
  $socket = Connect-Cdp $page.webSocketDebuggerUrl
  Assert-True (Wait-For $socket "document.querySelector('.cm-content') !== null") 'fixture opens in editor'

  Invoke-CdpEval $socket "document.querySelector('.cm-content')?.focus(); true" | Out-Null
  Send-CtrlKey $socket 'a' 65
  Send-CtrlKey $socket 'k' 75
  Assert-True (Wait-For $socket "document.querySelector('.ai-stream') !== null") 'Ctrl+K opens AI panel'

  Start-Sleep -Milliseconds 100
  $setRewriteInput = @'
(() => {
  const input = document.querySelector('.ai-stream__input');
  if (!input) return JSON.stringify({ error: 'rewrite input is missing' });
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(input, 'rewrite');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return JSON.stringify({ ok: true });
})()
'@
  $rewriteInput = (Invoke-CdpEval $socket ($setRewriteInput -replace "`r`n", ' ')) | ConvertFrom-Json
  Start-Sleep -Milliseconds 100
  $clickRewrite = @'
(() => {
  const send = document.querySelector('.ai-stream__actions .btn--primary');
  if (!send) return JSON.stringify({ error: 'rewrite send button is missing' });
  const disabled = send.disabled;
  if (!disabled) send.click();
  return JSON.stringify({ ok: true, disabled });
})()
'@
  $rewriteSend = (Invoke-CdpEval $socket ($clickRewrite -replace "`r`n", ' ')) | ConvertFrom-Json
  $reviewVisible = Wait-For $socket "document.querySelector('.rewrite-review') !== null" 8
  $rewriteState = @'
JSON.stringify({
  review: document.querySelector('.rewrite-review') !== null,
  original: document.querySelector('.cm-content')?.innerText ?? '',
  status: document.querySelector('.ai-stream__status')?.textContent ?? '',
  controls: [...document.querySelectorAll('.ai-stream__actions button')].map((button) => ({
    text: button.textContent?.trim(),
    disabled: button.disabled,
  })),
})
'@
  $rewrite = (Invoke-CdpEval $socket ($rewriteState -replace "`r`n", ' ')) | ConvertFrom-Json
  $rewriteReady =
    $null -ne $rewriteInput -and
    $rewriteInput.ok -and
    $null -ne $rewriteSend -and
    -not $rewriteSend.disabled -and
    $reviewVisible -and
    $rewrite.review -and
    $rewrite.original.Contains('original text')
  Assert-True $rewriteReady 'rewrite is reviewed before document mutation' "$($rewrite | ConvertTo-Json -Compress)"

  if ($rewriteReady) {
    Invoke-CdpEval $socket "document.querySelector('.rewrite-review__actions .btn--primary')?.click(); 'ok'" | Out-Null
    Start-Sleep -Milliseconds 100
    Invoke-CdpEval $socket "[...document.querySelectorAll('.ai-stream__actions button')][1]?.click(); 'ok'" | Out-Null
    Start-Sleep -Milliseconds 500
    $rewritten = Invoke-CdpEval $socket "document.querySelector('.cm-content')?.innerText ?? ''"
    Assert-True ($null -ne $rewritten -and $rewritten.Contains('rewritten text')) 'selected rewrite block applies once' "$rewritten"
  } else {
    Assert-True $false 'selected rewrite block applies once' 'skipped because no review was offered'
  }

  Invoke-CdpEval $socket "document.querySelector('.ai-stream__mode:not(.is-on)')?.click(); 'ok'" | Out-Null
  Start-Sleep -Milliseconds 100
  $setAskInput = @'
(() => {
  const input = document.querySelector('.ai-stream__input');
  if (!input) return JSON.stringify({ error: 'ask input is missing' });
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(input, 'what does the file contain?');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return JSON.stringify({ ok: true });
})()
'@
  $askInput = (Invoke-CdpEval $socket ($setAskInput -replace "`r`n", ' ')) | ConvertFrom-Json
  Start-Sleep -Milliseconds 100
  Invoke-CdpEval $socket "document.querySelector('.ai-stream__actions .btn--primary')?.click(); 'ok'" | Out-Null
  $answerVisible = Wait-For $socket "document.querySelector('.agent-answer__link') !== null" 8
  $answerState = @'
JSON.stringify({
  link: document.querySelector('.agent-answer__link')?.textContent ?? null,
  text: document.querySelector('.cm-content')?.innerText ?? '',
  status: document.querySelector('.ai-stream__status')?.textContent ?? '',
})
'@
  $answer = (Invoke-CdpEval $socket ($answerState -replace "`r`n", ' ')) | ConvertFrom-Json
  Assert-True ($null -ne $askInput -and $askInput.ok -and $answerVisible -and $answer.link -eq 'e2e-ai.txt:1') 'native tool call yields a navigable answer reference' "$($answer | ConvertTo-Json -Compress)"
  Invoke-CdpEval $socket "document.querySelector('.agent-answer__link')?.click(); 'ok'" | Out-Null
  Start-Sleep -Milliseconds 200
  Invoke-CdpEval $socket "document.querySelector('.agent-answer__actions .btn')?.click(); 'ok'" | Out-Null
  Start-Sleep -Milliseconds 200
  $answerText = Invoke-CdpEval $socket "document.querySelector('.cm-content')?.innerText ?? ''"
  Assert-True ($null -ne $answerText -and $answerText.Contains('mock answer')) 'answer inserts at the current caret' "$answerText"
} finally {
  if ($socket -and $storageChanged -and $null -ne $storageSnapshot) {
    try {
      $snapshotJs = ConvertTo-Json -InputObject $storageSnapshot -Compress
      $restoreScript = @"
const snapshot = JSON.parse($snapshotJs);
localStorage.clear();
Object.entries(snapshot).forEach(([key, value]) => localStorage.setItem(key, value));
setTimeout(() => location.reload(), 0);
'restored';
"@
      Invoke-CdpEval $socket ($restoreScript -replace "`r`n", ' ') | Out-Null
    } catch {
      $script:Failures++
      Write-Error "Failed to restore the app localStorage after AI E2E: $($_.Exception.Message)"
    }
  }
  if ($socket) { $socket.Dispose() }
  if ($mock -and -not $mock.HasExited) { Stop-Process -Id $mock.Id -Force }
  Remove-Item $fixtureDir -Recurse -Force -ErrorAction SilentlyContinue
}

if ($script:Failures -gt 0) {
  Write-Host "AI E2E smoke: $($script:Failures) check(s) failed." -ForegroundColor Red
  exit 1
}
Write-Host 'AI E2E smoke: all checks passed.' -ForegroundColor Green
