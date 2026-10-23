# RunPod execution

The paid experiment uses one Linux Pod with three RTX PRO 6000 Blackwell GPUs.
Each vLLM service is pinned to one GPU and exposed only on loopback. Pi runs in
offline mode against those endpoints.

## Safety gates

- A local preflight must pass before provisioning.
- The requested GPU count, GPU type, price, and budget are recorded before
  creation.
- A detached local watchdog terminates the Pod before the approved budget
  limit even if the main controller exits. RunPod CLI 3.0.1 does not expose the
  documented provider-side `terminate-after` flag, so the controller does not
  claim that protection is active when it is not.
- The main controller independently terminates the Pod after artifact download
  or on any error path.
- Results are downloaded and checksummed before normal termination.
- Missing artifacts do not cancel the hard termination deadline.

The approved ceiling for the initial redesigned benchmark is **$100.00**. The
controller calculates its termination interval from the live hourly price and
reserves a ten-percent safety margin.

## Intended sequence

1. Provision and wait for SSH readiness.
2. Upload this benchmark and the existing RHEL vLLM/Pi stack.
3. Start the three pinned model services and record startup metrics.
4. Run serving calibration, then the nine baseline product attempts.
5. If quality is sufficient and budget remains, run controlled optimization
   trials one factor at a time.
6. Download raw evidence, generate the report, verify hashes, and terminate.

## Controller

The reproducible entry point is `runpod/run-paid-pilot.ps1`. It queries the live
RunPod API for three-GPU price/availability, derives a maximum lifetime from the
approved budget with a ten-percent reserve, provisions through the official
RunPod CLI, starts the detached watchdog, waits for completion, downloads the
artifact bundle, finalizes cost metadata, and deletes the Pod in a `finally`
block.

The workflow publishes both a durable GHCR image and a unique anonymous
`ttl.sh` tag. The controller uses the 24-hour tag for the paid pilot so no
GitHub registry credential is copied to the Pod; its lifetime is longer than
the budget-derived maximum Pod lifetime.

