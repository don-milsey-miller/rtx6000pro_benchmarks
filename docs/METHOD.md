# Benchmark method

## Question

How many independently verified units of useful software work can the complete
vLLM + model + Pi stack deliver per hour and per dollar, and which configuration
changes improve that result without reducing correctness?

## Separation of concerns

ForgeBench records four layers independently:

1. **Serving:** vLLM latency, throughput, scheduling, KV-cache, prefix-cache,
   preemption, and reliability.
2. **Agent runtime:** Pi turns, context usage, compaction, tool selection, tool
   errors, and recovery behavior.
3. **Model behavior:** verified requirements completed, regressions, time, and
   unnecessary work.
4. **System outcome:** completed weighted product score per hour and per dollar.

This prevents a faster server from hiding a worse agent, or a better model from
being mistaken for a vLLM optimization.

## Task design

Every task starts from a minimal greenfield repository containing:

- a complete product specification;
- a runtime contract and package scripts;
- visible smoke checks that initially fail because the application is absent;
- no production implementation.

The agent may modify any project file and may create tests. Final grading uses a
separate pristine evaluator, so changing a visible check cannot change the
score. Hidden checks extend documented requirements with edge cases; they do
not introduce undocumented features.

## Trial protocol

1. Freeze suite version, task bundles, evaluators, model revisions, machine
   type, deadlines, and random seed.
2. Start from a fresh copy of each task for every trial.
3. Capture vLLM and GPU counters before the run.
4. Run Pi in JSON mode with a persisted session and a hard deadline.
5. Capture the final tree, diff, Pi stream, session, service metrics, and GPU
   telemetry.
6. Grade the application using an evaluator unavailable to the agent.
7. Produce a structured result and an HTML report from raw evidence.

## Evaluator lifecycle

Every task declares a per-check deadline, a cleanup reserve, and an outer
evaluator deadline in `config/suite.json`. Evaluators write an atomic partial
grade and append a JSONL event after every completed check. A timed-out check
stops further grading, preserves completed checks as evidence, marks remaining
checks unverified, and enters bounded cleanup. The parent runner has a second
outer bound and records a process-tree/listening-socket snapshot before it
terminates the evaluator process group.

Reference, empty, request-hang, SSE-hang, open-socket, evaluator-hang, and
termination-resistant fixtures exercise these paths. Exact timing choices are
versioned benchmark configuration and must be reassessed from measured runs;
they are never implicit library defaults.

## Autoresearch optimization loop

After the baseline, change one coherent factor per experiment. Examples include
batching, context length, KV-cache dtype, prefix caching, compaction thresholds,
thinking level, or agent supervision. A candidate is retained only when:

- no task loses required correctness;
- service and tool-call error rates remain within their gates;
- the predeclared primary efficiency metric improves beyond run-to-run noise.

Every candidate is logged as `keep`, `discard`, or `crash`. Failed experiments
remain evidence; their configuration is never silently folded into the next
trial.

## Repetition and interpretation

The first paid run is a calibration with one attempt per model/task cell. It is
not sufficient for model ranking. Stable comparisons require at least three
repetitions per cell with rotated execution order. Report medians and dispersion,
not only the best attempt.

