param(
  [Parameter(Mandatory = $true)][string]$EnvFile,
  [string]$OverlayFile,
  [ValidateSet('codex', 'claude')][string]$Mode = 'codex',
  [string]$BindAddress = '127.0.0.1',
  [int]$Port = 4317
)
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$taskEnv = (Resolve-Path -LiteralPath $EnvFile).Path
$taskNode = (Get-Command node -ErrorAction Stop).Source
$taskLogs = Join-Path $taskRoot 'logs/ai-bridge'
New-Item -ItemType Directory -Path $taskLogs -Force | Out-Null
# Only paths and non-secret overrides are passed on the command line. Node loads the env itself.
$taskArgs = @("--env-file=`"$taskEnv`"")
if ($OverlayFile) {
  $taskOverlay = (Resolve-Path -LiteralPath $OverlayFile).Path
  $taskArgs += "--env-file=`"$taskOverlay`""
}
$taskArgs += "`"$(Join-Path $PSScriptRoot 'server.mjs')`""
$taskPrevious = @{}
foreach ($taskName in @('AI_BRIDGE_MODE', 'AI_BRIDGE_HOST', 'AI_BRIDGE_PORT')) {
  $taskPrevious[$taskName] = [Environment]::GetEnvironmentVariable($taskName, 'Process')
}
try {
  $env:AI_BRIDGE_MODE = $Mode
  $env:AI_BRIDGE_HOST = $BindAddress
  $env:AI_BRIDGE_PORT = [string]$Port
  $taskProcess = Start-Process -FilePath $taskNode -ArgumentList $taskArgs -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskLogs 'stdout.log') -RedirectStandardError (Join-Path $taskLogs 'stderr.log')
  Set-Content -LiteralPath (Join-Path $taskLogs 'host.pid') -Value $taskProcess.Id
  Write-Output "AI bridge started (PID $($taskProcess.Id), mode $Mode, port $Port). Check /healthz before sending traffic."
} finally {
  foreach ($taskName in $taskPrevious.Keys) {
    [Environment]::SetEnvironmentVariable($taskName, $taskPrevious[$taskName], 'Process')
  }
}
