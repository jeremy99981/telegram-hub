param(
  [string]$BotToken = $env:TELEGRAM_BOT_TOKEN,
  [string]$HubApiToken = $env:HUB_API_TOKEN,
  [string]$ProjectKey = $env:TELEGRAM_PROJECT_KEY,
  [string]$Workspace = $env:CODEX_DEFAULT_WORKSPACE,
  [int]$Port = 8787
)

if (-not $BotToken) {
  throw "TELEGRAM_BOT_TOKEN manquant."
}
if (-not $HubApiToken) {
  throw "HUB_API_TOKEN manquant."
}
if (-not $ProjectKey) {
  $ProjectKey = "pilotage-ed"
}
if (-not $Workspace) {
  $Workspace = (Get-Location).Path
}

$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $root ".logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null

# Stop existing listeners/relays to avoid duplicates
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  cmd /c "taskkill /PID $($listener.OwningProcess) /F" | Out-Null
}

$relayProcs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "relay:codex|codex-telegram-relay" }
foreach ($p in $relayProcs) {
  cmd /c "taskkill /PID $($p.ProcessId) /F" | Out-Null
}

$serverCmd = "set TELEGRAM_BOT_TOKEN=$BotToken&& set TELEGRAM_WEBHOOK_SECRET=local-secret&& set HUB_API_TOKEN=$HubApiToken&& set TELEGRAM_AUTO_ACK=true&& set PORT=$Port&& cd /d $root&& npm run dev > .logs\local-server.log 2>&1"
$relayCmd = "set TELEGRAM_HUB_URL=http://127.0.0.1:$Port&& set HUB_API_TOKEN=$HubApiToken&& set TELEGRAM_PROJECT_KEY=$ProjectKey&& set TELEGRAM_THREAD_ID=default&& set CODEX_DEFAULT_WORKSPACE=$Workspace&& set CODEX_PROJECT_WORKSPACES=$ProjectKey=$Workspace&& cd /d $root&& npm run relay:codex > .logs\codex-relay.log 2>&1"

$serverProc = Start-Process -FilePath cmd.exe -ArgumentList "/c", $serverCmd -PassThru
Start-Sleep -Seconds 2
$relayProc = Start-Process -FilePath cmd.exe -ArgumentList "/c", $relayCmd -PassThru

Write-Output "STACK_STARTED"
Write-Output "ServerPid=$($serverProc.Id)"
Write-Output "RelayPid=$($relayProc.Id)"
Write-Output "Port=$Port"
