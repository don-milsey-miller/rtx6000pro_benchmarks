# Implementation decisions and open gates

Recorded 2026-10-23 for the implementation handoff based on the published RHEL
10 optimization study.

## Frozen evidence

- The annotated tag `forgebench-greenfield-v1-baseline` resolves to commit
  `c76ecd8` (dereferencing the annotated tag object).
- Implementation work starts from `main` commit
  `6ce2e07b5b4d2eb82978912d5d0e3f991354870f` on branch
  `implementation/evaluator-hardening`.
- `artifacts/paid-20261023-013238/forgebench-paid-20261023.tar.gz` is
  131,417,499 bytes and matches its adjacent SHA-256:
  `91cf9d43a943d7eea538b117243a7b2204e946af6c87794a8ce81f6a3c1acfcd`.
  Its 3,899 tar entries total 1,480,607,605 uncompressed bytes (about 1.38
  GiB), so the handoff's approximate 1.7 GB description appears to refer to
  expanded evidence rather than the compressed file. The exact values are
  recorded and the archive is retained unchanged.
- The current container tag resolves to OCI image-index digest
  `sha256:acfa0b256f4c73246cf52c65d66f015813a4bd0939f7669112373b6a7fe1a6c6`.
  Paid execution resolves and records the digest again immediately before
  provisioning, rather than trusting this observation indefinitely.

## RunPod status

At 2026-10-23 15:20 EDT, a read-only RunPod GraphQL query recognized the exact
`NVIDIA RTX PRO 6000 Blackwell Server Edition` type (96 GB per GPU) in both
Secure and Community Cloud, but `lowestPrice` for a three-GPU placement was
`null`. No matching placement was available to price or create, and no Pod was
created. The next baseline run remains a RunPod condition; bare-metal migration
is not part of it.

API access for discovery does not by itself authorize a paid Pod. Provisioning
is now authorized when a matching placement appears, with a hard campaign
ceiling of $70 and a ten-percent reserve. The controller may therefore allocate
at most $63 to measured Pod runtime and will wait up to six hours for capacity.

## Decisions made for WP-00 and WP-01

- The repository's actual suite ID remains `forgebench-v1`; it is recorded in
  each run manifest rather than being silently renamed to the handoff's
  descriptive `forgebench-greenfield-v1` label.
- The initial paired seed set is `6000`, `6001`, and `6002`. Seed `6000`
  preserves the historical reproduction point; the adjacent values make the
  new comparison set obvious and auditable.
- Evaluator deadlines are explicit task configuration, not code defaults:

  | Task | Per check | Cleanup reserve | Outer evaluator |
  | --- | ---: | ---: | ---: |
  | LinkLedger | 15 s | 10 s | 180 s |
  | HookBin | 20 s | 10 s | 240 s |
  | QueuePilot | 30 s | 15 s | 420 s |

  These are initial diagnostic limits for validation and replay. They must be
  reviewed against observed RunPod timings before WP-01 is promoted.
- The model revisions and thinking modes are now explicit in
  `config/models.json`: Qwen thinking is off; Muse and Gemma use medium. A run
  manifest records these values and keeps unsupported sampling values `null`.
- Evaluator outcome and suspected origin are separate fields. A timeout or
  incomplete evaluator is `unverified` with origin `unknown` unless evidence
  supports a more specific assignment; it is not converted into assertion
  failures.

## Decisions still required

The user has selected a $70 RunPod credit ceiling, approved Pod creation, and
specified that non-monetary costs are report-only. The recommended initial
policy is therefore:

1. Historical compatibility requires exact reference results, no regression in
   small or medium checks, Qwen QueuePilot within 16–18, Muse QueuePilot within
   14–17, and a verified Gemma result without imposing a speculative score
   floor. These are reproduction bands, not promotion criteria.
2. WP-03 permits up to three repair attempts. Tokens and repair wall time are
   recorded without separate caps; the provider watchdog remains the hard
   bound. Repair feedback may use only each task's published `SPEC.md`,
   `test/public.test.mjs`, and safe diagnostics derived from those public
   obligations. Everything under `evaluators/` and `validation/reference/`
   remains held out; its check names, source, reference behavior, and private
   output may not enter a repair prompt.
3. Promotion retains correctness gates: three consecutive full critical-task
   passes, no orphan processes, and no secret leakage. p95 wall time, token use,
   and energy are report-only. There is no per-success dollar cap separate from
   the $70 campaign ceiling.
4. Before WP-05, verify Pi 1.2.0 compaction hooks from installed source. A Pi
   fork or core patch still requires a separate decision.

