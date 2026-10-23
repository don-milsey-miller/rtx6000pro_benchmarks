[CmdletBinding()]
param(
  [double]$BudgetUsd = 100.00,
  [double]$PriorSpendUsd = 0.00,
  [double]$SafetyFraction = 0.10,
  [string]$Image = "ttl.sh/forgebench-rhel10-01a1613354a177e386dfe5e80dd21601:24h",
  [string]$GpuType = "NVIDIA RTX PRO 6000 Blackwell Server Edition",
  [int]$GpuCount = 3,
  [int]$ContainerDiskGb = 60,
  [int]$VolumeGb = 350,
  [string]$SshKey = "$env:USERPROFILE\.ssh\runpod_ed25519",
  [string]$Repository = "https://github.com/don-milsey-miller/rtx6000pro_benchmarks.git",
  [string]$RunPodCtl = "$env:LOCALAPPDATA\RunPod\runpodctl.exe"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$podId = $null
$watchdogMarker = $null
$startedAt = $null
$hourlyRate = 0.0

function Invoke-GraphQL([string]$Query) {
  if ([string]::IsNullOrWhiteSpace($env:RUNPOD_API_KEY)) { throw "RUNPOD_API_KEY is not set" }
  $headers = @{ Authorization = "Bearer $env:RUNPOD_API_KEY" }
  $body = @{ query = $Query } | ConvertTo-Json -Compress
  $response = Invoke-RestMethod -Uri "https://api.runpod.io/graphql" -Method Post -Headers $headers -ContentType "application/json" -Body $body
  if (($response.PSObject.Properties.Name -contains "errors") -and $response.errors) {
    throw ($response.errors | ConvertTo-Json -Depth 8)
  }
  return $response.data
}

function Invoke-Ssh([string]$HostName, [int]$Port, [string]$Command) {
  & ssh -i $SshKey -p $Port -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "root@$HostName" $Command
  if ($LASTEXITCODE -ne 0) { throw "remote command failed with exit code $LASTEXITCODE" }
}

if (!(Test-Path -LiteralPath $RunPodCtl)) { throw "runpodctl not found at $RunPodCtl" }
if (!(Test-Path -LiteralPath $SshKey)) { throw "SSH key not found at $SshKey" }
if (!(Test-Path -LiteralPath "$SshKey.pub")) { throw "SSH public key not found at $SshKey.pub" }
if ($BudgetUsd -le 0 -or $SafetyFraction -lt 0.05 -or $SafetyFraction -ge 0.5) { throw "unsafe budget settings" }

Push-Location $root
try {
  npm run check
  if ($LASTEXITCODE -ne 0) { throw "local benchmark validation failed" }

  $escapedGpu = $GpuType.Replace('"', '\"')
  $availability = Invoke-GraphQL "query { gpuTypes(input: { id: `"$escapedGpu`" }) { id displayName memoryInGb secureCloud communityCloud lowestPrice(input: { gpuCount: $GpuCount }) { uninterruptablePrice minimumBidPrice } } }"
  $gpu = @($availability.gpuTypes) | Select-Object -First 1
  if (!$gpu -or (!$gpu.communityCloud -and !$gpu.secureCloud)) { throw "$GpuType is unavailable" }
  $hourlyRate = [double]$gpu.lowestPrice.uninterruptablePrice
  if ($hourlyRate -le 0) { throw "RunPod returned no on-demand price for $GpuCount GPUs" }
  $maxRuntimeSeconds = [math]::Floor(($BudgetUsd * (1 - $SafetyFraction) / $hourlyRate) * 3600)
  if ($maxRuntimeSeconds -lt 3600) { throw "approved budget leaves less than one hour after the safety reserve" }

  $stamp = [datetime]::UtcNow.ToString("yyyyMMdd-HHmmss")
  $localRun = Join-Path $root "artifacts\paid-$stamp"
  New-Item -ItemType Directory -Force -Path $localRun | Out-Null
  $watchdogMarker = Join-Path $localRun "watchdog.cancel"
  $state = [ordered]@{
    requestedAt = [datetime]::UtcNow.ToString("o")
    gpuType = $GpuType
    gpuCount = $GpuCount
    hourlyRateUsd = $hourlyRate
    budgetUsd = $BudgetUsd
    priorSpendUsd = $PriorSpendUsd
    safetyFraction = $SafetyFraction
    maximumRuntimeSeconds = $maxRuntimeSeconds
    image = $Image
  }
  $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $localRun "provision-request.json")

  $publicKey = (Get-Content -Raw -LiteralPath "$SshKey.pub").Trim()
  $publicKeyB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($publicKey))
  $environment = (@{ PUBLIC_KEY_B64 = $publicKeyB64 } | ConvertTo-Json -Compress).Replace('"', '\"')
  $podName = "forgebench-$stamp"
  $clouds = @("COMMUNITY", "SECURE")
  $placementDeadline = [datetime]::UtcNow.AddHours(6)
  $placementAttempt = 0
  $created = $null
  $selectedCloud = $null
  while (!$created -and [datetime]::UtcNow -lt $placementDeadline) {
    $selectedCloud = $clouds[$placementAttempt % $clouds.Count]
    $createArgs = @(
      "pod", "create", "--image", $Image, "--name", $podName,
      "--gpu-id", $GpuType, "--gpu-count", "$GpuCount", "--cloud-type", $selectedCloud,
      "--container-disk-in-gb", "$ContainerDiskGb", "--volume-in-gb", "$VolumeGb",
      "--volume-mount-path", "/workspace", "--ports", "22/tcp", "--ssh",
      "--env", $environment, "--min-cuda-version", "13.0"
    )
    $savedErrorPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $createdText = (& $RunPodCtl @createArgs 2>&1 | Out-String).Trim()
      $createExit = $LASTEXITCODE
    }
    finally {
      $ErrorActionPreference = $savedErrorPreference
    }
    if ($createExit -eq 0) {
      $created = $createdText | ConvertFrom-Json
      break
    }

    # A transport failure can occur after RunPod accepted the request. Look for
    # the unique name before retrying so the controller can never create two Pods.
    $existingText = (& $RunPodCtl pod list --all 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and $existingText) {
      $existing = @($existingText | ConvertFrom-Json) | Where-Object {
        $_ -and ($_.PSObject.Properties.Name -contains "name") -and $_.name -eq $podName
      } | Select-Object -First 1
      if ($existing) { $created = $existing; break }
    }
    if ($createdText -notmatch "no longer any instances|no instances available|capacity|unavailable") {
      throw "RunPod creation failed: $createdText"
    }
    $placementAttempt++
    if (($placementAttempt % 4) -eq 0) { Write-Host "Waiting for a three-GPU placement; tried both cloud tiers $placementAttempt times." }
    Start-Sleep -Seconds 30
  }
  if (!$created) { throw "No three-GPU placement became available within six hours" }
  $podId = [string]$created.id
  if ([string]::IsNullOrWhiteSpace($podId)) { throw "RunPod did not return a Pod id" }
  if (($created.PSObject.Properties.Name -contains "costPerHr") -and $created.costPerHr) {
    $hourlyRate = [double]$created.costPerHr
  }
  $maxRuntimeSeconds = [math]::Floor(($BudgetUsd * (1 - $SafetyFraction) / $hourlyRate) * 3600)
  if ($maxRuntimeSeconds -lt 3600) { throw "actual Pod rate leaves less than one hour after the safety reserve" }
  $startedAt = [datetime]::UtcNow
  $state.podId = $podId
  $state.createdAt = $startedAt.ToString("o")
  $state.actualHourlyRateUsd = $hourlyRate
  $state.maximumRuntimeSeconds = $maxRuntimeSeconds
  $state.cloudType = $selectedCloud
  $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $localRun "provision-result.json")

  $deadline = $startedAt.AddSeconds($maxRuntimeSeconds)
  $watchdogLog = Join-Path $localRun "watchdog.log"
  $watchdogScript = Join-Path $PSScriptRoot "watchdog.ps1"
  $watchdogArgs = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$watchdogScript`"",
    "-PodId", $podId, "-DeadlineUtc", $deadline.ToString("o"),
    "-CompletionMarker", "`"$watchdogMarker`"", "-LogPath", "`"$watchdogLog`"",
    "-RunPodCtl", "`"$RunPodCtl`""
  )
  Start-Process -FilePath "powershell.exe" -ArgumentList $watchdogArgs -WindowStyle Hidden | Out-Null
  Write-Host "Created Pod $podId at `$$hourlyRate/hour; watchdog deadline is $($deadline.ToString('o'))."

  $sshInfo = $null
  for ($attempt = 1; $attempt -le 180; $attempt++) {
    $raw = & $RunPodCtl ssh info $podId 2>$null
    if ($LASTEXITCODE -eq 0) {
      $candidate = $raw | ConvertFrom-Json
      if (($candidate.PSObject.Properties.Name -contains "ip") -and
          ($candidate.PSObject.Properties.Name -contains "port") -and
          $candidate.ip -and $candidate.port) {
        $sshInfo = $candidate
        break
      }
    }
    if (($attempt % 12) -eq 0) { Write-Host "Waiting for the RHEL image and SSH mapping ($($attempt * 10)s elapsed)..." }
    Start-Sleep -Seconds 10
  }
  if (!$sshInfo) { throw "Pod did not become reachable over SSH within 30 minutes" }
  $hostName = [string]$sshInfo.ip
  $sshPort = [int]$sshInfo.port

  Invoke-Ssh $hostName $sshPort "git clone --depth 1 $Repository /workspace/benchmark && chmod +x /workspace/benchmark/runpod/*.sh && setsid -f bash /workspace/benchmark/runpod/execute.sh >/workspace/results/controller-execute.log 2>&1 </dev/null"
  Write-Host "Remote benchmark started."

  $lastProgress = [datetime]::MinValue
  while ([datetime]::UtcNow -lt $deadline) {
    $complete = & ssh -i $SshKey -p $sshPort -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "root@$hostName" "test -s /workspace/results/completion.json && cat /workspace/results/completion.json" 2>$null
    if ($LASTEXITCODE -eq 0 -and $complete) { Write-Host "Remote completion: $complete"; break }
    if (([datetime]::UtcNow - $lastProgress).TotalMinutes -ge 5) {
      $tail = & ssh -i $SshKey -p $sshPort -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "root@$hostName" "tail -n 5 /workspace/results/execute.log 2>/dev/null || tail -n 5 /workspace/results/controller-execute.log 2>/dev/null || true" 2>$null
      Write-Host "Progress $([datetime]::UtcNow.ToString('o'))`n$tail"
      $lastProgress = [datetime]::UtcNow
    }
    Start-Sleep -Seconds 30
  }

  Invoke-Ssh $hostName $sshPort "tar -C /workspace -czf /workspace/forgebench-results.tgz results"
  & scp -i $SshKey -P $sshPort -o BatchMode=yes -o StrictHostKeyChecking=accept-new "root@${hostName}:/workspace/forgebench-results.tgz" (Join-Path $localRun "forgebench-results.tgz")
  if ($LASTEXITCODE -ne 0) { throw "artifact download failed" }
  tar -xzf (Join-Path $localRun "forgebench-results.tgz") -C $localRun
  if ($LASTEXITCODE -ne 0) { throw "artifact extraction failed" }

  $elapsedHours = ([datetime]::UtcNow - $startedAt).TotalHours
  $currentRunUsd = [math]::Round($elapsedHours * $hourlyRate, 4)
  $billedUsd = [math]::Round($PriorSpendUsd + $currentRunUsd, 4)
  $resultsJson = Join-Path $localRun "results\forgebench\results.json"
  $reportHtml = Join-Path $localRun "FORGEBENCH-PAID-PILOT.html"
  $env:BENCH_BILLED_USD = "$billedUsd"
  $env:BENCH_CURRENT_RUN_USD = "$currentRunUsd"
  $env:BENCH_PRIOR_SPEND_USD = "$PriorSpendUsd"
  $env:BENCH_RUNPOD_POD_ID = $podId
  $env:BENCH_RUNPOD_HOURLY_RATE = "$hourlyRate"
  $env:BENCH_RUNPOD_ELAPSED_HOURS = "$elapsedHours"
  node scripts/finalize-paid-run.mjs $resultsJson $reportHtml
  if ($LASTEXITCODE -ne 0) { throw "final report generation failed" }
  Write-Host "Report: $reportHtml"
}
finally {
  if ($podId) {
    & $RunPodCtl pod delete $podId 2>&1 | Write-Host
  }
  if ($watchdogMarker) {
    New-Item -ItemType File -Force -Path $watchdogMarker | Out-Null
  }
  Pop-Location
}
