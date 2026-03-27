param(
  [int]$Port = 8787
)

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  cmd /c "taskkill /PID $($listener.OwningProcess) /F" | Out-Null
}

$targetProcs = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -match "local-server|relay:codex|codex-telegram-relay"
}

foreach ($proc in $targetProcs) {
  cmd /c "taskkill /PID $($proc.ProcessId) /F" | Out-Null
}

Write-Output "STACK_STOPPED"
