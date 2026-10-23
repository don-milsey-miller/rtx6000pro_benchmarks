# Metrics and scoring

## Correctness and completion

Each evaluator emits named checks and a `passed / total` completion fraction.
Task weights reflect scope: small `1`, medium `3`, large `8`. The primary quality
measure is weighted completion:

`sum(task_weight * completion_fraction) / sum(task_weight)`

A run is fully complete only when every required check passes and the process
exits cleanly. Partial credit is diagnostic and cannot be called a pass.

## Pi and model

- wall time and termination reason;
- assistant turns and model requests;
- input, output, reasoning, cache-read, and cache-write tokens;
- peak reported context tokens and context-window utilization;
- compaction count, tokens before compaction, and retained-summary count;
- tool calls by tool name, failures, duration, and repeated command/file access;
- changed files, lines added/deleted, test commands, and final response presence.

## vLLM

Raw `/metrics` snapshots are retained. Derived fields include:

- request success/error counts;
- prompt and generation tokens;
- mean and percentile TTFT, TPOT, ITL, and end-to-end latency when exposed;
- running/waiting requests and queue saturation;
- KV-cache usage samples and peak;
- prefix-cache queries, hits, and hit rate;
- preemptions and service restarts;
- generated tokens per second and requests per minute.

Prefix-cache results are reported as cold and warm observations because repeated
prompts can inflate apparent throughput.

## GPU and host

- utilization, VRAM used, power, temperature, and SM clock by GPU;
- CPU load, memory, disk, process restarts, and model startup duration;
- p50, p95, maximum, and time-weighted means where meaningful.

## Optimization objective

Correctness is a hard gate. Among configurations with no correctness regression,
rank by useful work rate:

`weighted_completed_work / max(agent_wall_hours, provider_billed_hours)`

Cost efficiency is reported separately as weighted completed work per dollar.
No composite score is allowed to convert an incorrect result into a winner.

