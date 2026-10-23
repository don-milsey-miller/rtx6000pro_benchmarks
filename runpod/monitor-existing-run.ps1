[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PodId,
  [Parameter(Mandatory = $true)][string]$HostName,
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][string]$RunDirectory,
  [Parameter(Mandatory = $true)][datetime]$DeadlineUtc,
  [string]$SshKey = "$env:USERPROFILE\.ssh\runpod_ed25519",
  [string]$RunPodCtl = "$env:LOCALAPPDATA\RunPod\runpodctl.exe"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$completionMarker = Join-Path $RunDirectory "watchdog.cancel"
$statePath = Join-Path $RunDirectory "provision-result.json"
$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
$remoteExitCode = $null

function Invoke-ProcessCapture(
  [string]$FileName,
  [string[]]$Arguments,
  [int]$TimeoutSeconds
) {
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FileName
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in $Arguments) { $startInfo.ArgumentList.Add($argument) }
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (!$process.Start()) { throw "failed to start $FileName" }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (!$process.WaitForExit($TimeoutSeconds * 1000)) {
    try { $process.Kill($true) } catch { $process.Kill() }
    throw "$FileName exceeded its $TimeoutSeconds-second deadline"
  }
  return [pscustomobject]@{
    ExitCode = $process.ExitCode
    Stdout = $stdoutTask.GetAwaiter().GetResult().Trim()
    Stderr = $stderrTask.GetAwaiter().GetResult().Trim()
  }
}

function Invoke-SshCapture([string]$Command, [int]$TimeoutSeconds = 30) {
  return Invoke-ProcessCapture "ssh.exe" @(
    "-i", $SshKey, "-p", "$Port", "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15",
    "root@$HostName", $Command
  ) $TimeoutSeconds
}

Push-Location $root
try {
  $lastProgress = [datetime]::MinValue
  while ([datetime]::UtcNow -lt $DeadlineUtc.ToUniversalTime()) {
    try {
      $poll = Invoke-SshCapture "test -s /workspace/results/completion.json && cat /workspace/results/completion.json" 25
      if ($poll.ExitCode -eq 0 -and $poll.Stdout) {
        $completion = $poll.Stdout | ConvertFrom-Json
        $remoteExitCode = [int]$completion.exitCode
        Write-Host "Remote completion: $($poll.Stdout)"
        break
      }
    }
    catch {
      Write-Warning "Completion poll failed: $($_.Exception.Message)"
    }

    if (([datetime]::UtcNow - $lastProgress).TotalMinutes -ge 5) {
      try {
        $progress = Invoke-SshCapture "tail -n 8 /workspace/results/execute.log 2>/dev/null || tail -n 8 /workspace/results/controller-execute.log 2>/dev/null || true" 25
        Write-Host "Progress $([datetime]::UtcNow.ToString('o'))`n$($progress.Stdout)"
      }
      catch {
        Write-Warning "Progress poll failed: $($_.Exception.Message)"
      }
      $lastProgress = [datetime]::UtcNow
    }
    Start-Sleep -Seconds 30
  }

  if ($null -eq $remoteExitCode) { throw "remote run did not complete before the provider deadline" }

  $archive = Invoke-SshCapture "tar -C /workspace -czf /workspace/forgebench-results.tgz results" 180
  if ($archive.ExitCode -ne 0) { throw "remote artifact archive failed: $($archive.Stderr)" }
  $localArchive = Join-Path $RunDirectory "forgebench-results.tgz"
  $copy = Invoke-ProcessCapture "scp.exe" @(
    "-i", $SshKey, "-P", "$Port", "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "root@${HostName}:/workspace/forgebench-results.tgz", $localArchive
  ) 600
  if ($copy.ExitCode -ne 0) { throw "artifact download failed: $($copy.Stderr)" }
  tar -xzf $localArchive -C $RunDirectory
  if ($LASTEXITCODE -ne 0) { throw "artifact extraction failed" }

  $createdUtc = [datetime]::SpecifyKind([datetime]$state.createdAt, [DateTimeKind]::Utc)
  $elapsedHours = ([datetime]::UtcNow - $createdUtc).TotalHours
  $currentRunUsd = [math]::Round($elapsedHours * [double]$state.actualHourlyRateUsd, 4)
  $resultsJson = Join-Path $RunDirectory "results\forgebench\results.json"
  $reportHtml = Join-Path $RunDirectory "FORGEBENCH-PAID-PILOT.html"
  if (Test-Path -LiteralPath $resultsJson) {
    $env:BENCH_BILLED_USD = "$currentRunUsd"
    $env:BENCH_CURRENT_RUN_USD = "$currentRunUsd"
    $env:BENCH_PRIOR_SPEND_USD = "0"
    $env:BENCH_RUNPOD_POD_ID = $PodId
    $env:BENCH_RUNPOD_HOURLY_RATE = "$($state.actualHourlyRateUsd)"
    $env:BENCH_RUNPOD_ELAPSED_HOURS = "$elapsedHours"
    node scripts/finalize-paid-run.mjs $resultsJson $reportHtml
    if ($LASTEXITCODE -ne 0) { throw "final report generation failed" }
    Write-Host "Report: $reportHtml"
  }
  if ($remoteExitCode -ne 0) { throw "remote benchmark exited with code $remoteExitCode" }
}
finally {
  & $RunPodCtl pod delete $PodId 2>&1 | Write-Host
  New-Item -ItemType File -Force -Path $completionMarker | Out-Null
  Pop-Location
}
