#requires -Version 5.1
<#
Ship a change end to end: run the frontend checks, commit, push, open (or reuse)
a pull request, wait for the required checks, then squash-merge and clean up.

The repository is public and master is protected, so every change goes through a
PR with six required checks (frontend + Rust on Windows/macOS/Ubuntu).

Examples
  scripts/ship.ps1 -Title "feat(i18n): add English UI"
  scripts/ship.ps1 -Title "fix: watcher race" -Body "Closes #12"
  scripts/ship.ps1 -Title "docs: tweak" -NoMerge
  scripts/ship.ps1 -Title "chore: deps" -SkipChecks

Requirements: git with a stored GitHub credential (git credential fill), pnpm.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [string]$Body = "",
  [string]$Branch = "",
  [string]$Base = "master",
  [switch]$NoMerge,
  [switch]$SkipChecks,
  [int]$CheckTimeoutMinutes = 45,
  [int]$RequiredChecks = 6
)

$ErrorActionPreference = "Stop"
$env:GIT_TERMINAL_PROMPT = "0"

function Fail([string]$Message) {
  Write-Host "ship: $Message" -ForegroundColor Red
  exit 1
}

function Step([string]$Message) {
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-Git {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  & git @Arguments
  if ($LASTEXITCODE -ne 0) { Fail "git $($Arguments -join ' ') failed" }
}

# ---------------------------------------------------------------- repository
$root = (& git rev-parse --show-toplevel 2>$null)
if (-not $root) { Fail "not inside a git repository" }
Set-Location $root.Trim()
Step "repository: $($root.Trim())"

$remote = (& git remote get-url origin 2>$null)
if (-not $remote) { Fail "no origin remote" }
$remoteMatch = [regex]::Match($remote, 'github\.com[:/](?<owner>[^/]+)/(?<repo>[^/]+?)(\.git)?$')
if (-not $remoteMatch.Success) { Fail "origin is not a GitHub remote: $remote" }
$owner = $remoteMatch.Groups['owner'].Value
$repo = $remoteMatch.Groups['repo'].Value

Invoke-Git @('fetch', 'origin', $Base, '--quiet')
$current = (& git rev-parse --abbrev-ref HEAD).Trim()

# ---------------------------------------------------------------- branch
$slug = ($Title.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
if (-not $slug) { $slug = 'change' }
if (-not $Branch) {
  if ($current -ne $Base) { $Branch = $current } else { $Branch = "ship/$slug" }
}
if ($current -eq $Base) {
  Step "creating branch $Branch from $Base"
  Invoke-Git @('checkout', '-b', $Branch)
} elseif ($current -ne $Branch) {
  Fail "on branch $current but expected $Branch (checkout the branch you want to ship)"
}

# ---------------------------------------------------------------- pre-push checks
if (-not $SkipChecks) {
  Step "tsc --noEmit"
  & pnpm exec tsc --noEmit
  if ($LASTEXITCODE -ne 0) { Fail "tsc failed" }

  Step "eslint ."
  & pnpm exec eslint .
  if ($LASTEXITCODE -ne 0) { Fail "eslint failed" }

  Step "prettier --check ."
  & pnpm exec prettier --check .
  if ($LASTEXITCODE -ne 0) { Fail "prettier --check failed" }

  Step "vitest run"
  & pnpm exec vitest run
  if ($LASTEXITCODE -ne 0) { Fail "vitest failed" }
}

# ---------------------------------------------------------------- commit
$dirty = (& git status --porcelain)
if ($dirty) {
  Step "committing changes"
  Invoke-Git @('add', '-A')
  Invoke-Git @('commit', '-m', $Title)
} else {
  Step "nothing to commit, shipping existing commits on $Branch"
}

$head = (& git rev-parse HEAD).Trim()
$baseRef = "origin/$Base"
$ahead = [int]((& git rev-list --count "$baseRef..HEAD").Trim())
if ($ahead -lt 1) { Fail "no commits ahead of $Base; nothing to ship" }
Step "$ahead commit(s) ahead of $Base"

# ---------------------------------------------------------------- push
Step "pushing $Branch"
Invoke-Git @('push', '-u', 'origin', $Branch)

# ---------------------------------------------------------------- token
$token = $null
try {
  $credential = "protocol=https`nhost=github.com`n`n" | & git credential fill 2>$null
  $passwordLine = $credential | Where-Object { $_ -like 'password=*' } | Select-Object -First 1
  if ($passwordLine) { $token = $passwordLine.Substring(9).Trim() }
} catch {
  $token = $null
}

$compareUrl = "https://github.com/$owner/$repo/compare/$Base...${Branch}?expand=1"
if (-not $token) {
  Write-Host "ship: no GitHub token available from git credential fill." -ForegroundColor Yellow
  Write-Host "ship: branch pushed; open the pull request manually: $compareUrl" -ForegroundColor Yellow
  exit 0
}

$headers = @{
  Authorization          = "Bearer $token"
  Accept                 = 'application/vnd.github+json'
  'User-Agent'           = '6byte-ship'
  'X-GitHub-Api-Version' = '2022-11-28'
}
$api = "https://api.github.com/repos/$owner/$repo"

# ---------------------------------------------------------------- pull request
$pr = $null
try {
  $existing = @(Invoke-RestMethod "$api/pulls?state=open&head=$owner`:$Branch" -Headers $headers -TimeoutSec 30)
  if ($existing.Count -ge 1) { $pr = $existing[0] }
} catch {
  # A lookup failure must not block creating the PR.
}
if ($pr) {
  Step "reusing PR #$($pr.number)"
} else {
  Step "creating pull request"
  $payload = @{ title = $Title; head = $Branch; base = $Base; body = $Body } | ConvertTo-Json -Compress
  try {
    $pr = Invoke-RestMethod "$api/pulls" -Method Post -Headers $headers `
      -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 30
  } catch {
    Write-Host "ship: could not create the pull request: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "ship: open it manually: $compareUrl" -ForegroundColor Yellow
    exit 1
  }
}
Write-Host "ship: PR #$($pr.number) $($pr.html_url)" -ForegroundColor Green

# ---------------------------------------------------------------- checks
Step "waiting for $RequiredChecks checks (timeout ${CheckTimeoutMinutes}m)"
$deadline = (Get-Date).AddMinutes($CheckTimeoutMinutes)
$checks = $null
while ((Get-Date) -lt $deadline) {
  try {
    $response = Invoke-RestMethod "$api/commits/$head/check-runs" -Headers $headers -TimeoutSec 30
    $checks = @($response.check_runs)
  } catch {
    $checks = $null
  }
  if ($checks) {
    $pending = @($checks | Where-Object { $_.status -ne 'completed' }).Count
    if ($checks.Count -ge $RequiredChecks -and $pending -eq 0) { break }
    Write-Host "ship: $($checks.Count) check(s), $pending pending" -ForegroundColor DarkGray
  } else {
    Write-Host "ship: checks not registered yet" -ForegroundColor DarkGray
  }
  Start-Sleep -Seconds 15
}

if (-not $checks) { Fail "could not read check runs" }
$pending = @($checks | Where-Object { $_.status -ne 'completed' })
if ($pending.Count -gt 0) { Fail "timed out with $($pending.Count) check(s) still running" }

$failed = @($checks | Where-Object { $_.conclusion -ne 'success' -and $_.conclusion -ne 'neutral' -and $_.conclusion -ne 'skipped' })
foreach ($check in $checks) { Write-Host ("ship: {0} = {1}" -f $check.name, $check.conclusion) }
if ($failed.Count -gt 0) {
  Fail ("checks failed: " + (($failed | ForEach-Object { $_.name }) -join ', ') + "; fix and re-run")
}

# ---------------------------------------------------------------- merge
if ($NoMerge) {
  Write-Host "ship: checks are green; -NoMerge set, leaving PR #$($pr.number) open" -ForegroundColor Green
  exit 0
}

Step "squash-merging PR #$($pr.number)"
$mergePayload = @{
  merge_method  = 'squash'
  commit_title  = $Title
  commit_message = if ($Body) { $Body } else { 'Squashed by scripts/ship.ps1 after all required checks passed.' }
} | ConvertTo-Json -Compress
try {
  $merged = Invoke-RestMethod "$api/pulls/$($pr.number)/merge" -Method Put -Headers $headers `
    -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($mergePayload)) -TimeoutSec 30
} catch {
  Fail "merge failed: $($_.Exception.Message)"
}
if (-not $merged.merged) { Fail "GitHub did not merge the pull request" }
Write-Host "ship: merged as $($merged.sha.Substring(0, 7))" -ForegroundColor Green

# ---------------------------------------------------------------- cleanup
Step "back to $Base and cleaning up"
Invoke-Git @('checkout', $Base)
Invoke-Git @('pull', '--ff-only')
try { & git branch -D $Branch 2>$null } catch { }
try { & git push origin --delete $Branch 2>$null } catch { }
Write-Host "ship: done. Next: tag a release (git tag -a vX.Y.Z -m vX.Y.Z; git push origin vX.Y.Z)." -ForegroundColor Green