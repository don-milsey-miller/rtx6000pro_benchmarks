# ForgeBench: AI agent stack benchmark

ForgeBench measures whether a Linux-hosted coding agent can create working
software, and how efficiently the vLLM + model + Pi Coding Agent stack enables
that work. It is a greenfield product benchmark, not a historical bug-fix
benchmark.

The first suite contains three independently graded products:

| Scale | Product | Core challenge | Time bound |
| --- | --- | --- | ---: |
| Small | LinkLedger | Persistent bookmark SaaS with API and UI | 20 min |
| Medium | HookBin | Authenticated webhook inbox with replay | 60 min |
| Large | QueuePilot | Multi-tenant work tracker with audit and SSE | 120 min |

All workloads run on Linux with Node.js 24 and its standard library. Agents get
visible acceptance checks and may add their own tests. Independent evaluators
exercise the finished applications after submission. There is no Windows CI and
no dependency on any production repository.

## What is measured

- Product completion: independent black-box acceptance checks and partial score.
- Agent behavior: turns, tool calls, tool errors, tokens, context growth,
  compactions, repeated reads/commands, changed files, and wall time.
- vLLM: request counts, TTFT, TPOT, end-to-end latency, generation throughput,
  waiting/running requests, preemptions, KV-cache pressure, and prefix-cache hits.
- Host/GPU: utilization, VRAM, power, temperature, CPU, RAM, and service health.
- Economics: useful completion score per wall-clock hour and per provider dollar.

## Local validation

```bash
npm test
npm run validate
npm run build:bundles
npm run dry-run
```

`npm run validate` runs every independent evaluator against a known-good
reference implementation and verifies that a deliberately empty implementation
fails. Reference implementations are validation fixtures only and are never
included in agent bundles.

## Paid execution

Paid execution is gated by `scripts/preflight.mjs`. It refuses to run unless the
suite, bundles, reference validation, model configuration, telemetry paths, and
budget declaration all pass. See [docs/METHOD.md](docs/METHOD.md),
[docs/METRICS.md](docs/METRICS.md), and [docs/RUNPOD.md](docs/RUNPOD.md).

The RHEL 10 image is built by GitHub Actions from `runpod/image/Containerfile`.
The paid entry point is `runpod/run-paid-pilot.ps1`; it checks live three-GPU
availability/pricing through the RunPod API and installs a separate hard-budget
watchdog before remote setup begins.

