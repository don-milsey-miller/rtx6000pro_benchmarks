[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PodId,
  [Parameter(Mandatory = $true)][datetime]$DeadlineUtc,
  [Parameter(Mandatory = $true)][string]$CompletionMarker,
  [Parameter(Mandatory = $true)][string]$LogPath,
  [string]$RunPodCtl = "$env:LOCALAPPDATA\RunPod\runpodctl.exe"
)

$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null
"watchdog_started=$([datetime]::UtcNow.ToString('o')) deadline=$($DeadlineUtc.ToUniversalTime().ToString('o')) pod=$PodId" | Add-Content -LiteralPath $LogPath

while ([datetime]::UtcNow -lt $DeadlineUtc.ToUniversalTime()) {
  if (Test-Path -LiteralPath $CompletionMarker) {
    "watchdog_cancelled=$([datetime]::UtcNow.ToString('o'))" | Add-Content -LiteralPath $LogPath
    exit 0
  }
  Start-Sleep -Seconds 30
}

if (Test-Path -LiteralPath $CompletionMarker) {
  "watchdog_cancelled=$([datetime]::UtcNow.ToString('o'))" | Add-Content -LiteralPath $LogPath
  exit 0
}

"watchdog_deadline_reached=$([datetime]::UtcNow.ToString('o'))" | Add-Content -LiteralPath $LogPath
& $RunPodCtl pod delete $PodId 2>&1 | Add-Content -LiteralPath $LogPath
"watchdog_delete_finished=$([datetime]::UtcNow.ToString('o')) exit=$LASTEXITCODE" | Add-Content -LiteralPath $LogPath
exit $LASTEXITCODE
