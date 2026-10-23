import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { copyTree, treeManifest, writeJson } from "./fs.mjs";
import { summarizePiEvents } from "./pi-events.mjs";
import { buildRunManifest } from "./manifest.mjs";
import { runBounded } from "./process.mjs";
import { summarizeVllmMetrics } from "./prometheus.mjs";
import { redactText } from "./redact.mjs";
import { fetchText, summarizeGpu, summarizeHost, TelemetrySampler } from "./telemetry.mjs";

const now = () => new Date().toISOString();

async function initializeGit(workspace) {
  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "ForgeBench"],
    ["config", "user.email", "benchmark@localhost"],
    ["add", "."],
    ["commit", "-qm", "benchmark seed"],
  ]) {
    const result = await runBounded("git", args, { cwd: workspace, timeoutMs: 30_000 });
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  }
}

async function findSessionText(directory) {
  const candidates = [];
  async function visit(path) {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) candidates.push(child);
    }
  }
  await visit(directory);
  const texts = await Promise.all(candidates.map((path) => readFile(path, "utf8")));
  return texts.join("\n");
}

async function gitEvidence(workspace) {
  // Intent-to-add makes Git expose untracked product files in diff/numstat
  // without staging their contents. Most benchmark seeds intentionally omit
  // src/, so ignoring untracked files would discard the agent's main artifact.
  const intent = await runBounded("git", ["add", "-N", "."], { cwd: workspace, timeoutMs: 30_000 });
  if (intent.code !== 0) throw new Error(`git add -N failed: ${intent.stderr}`);
  const [status, diff, numstat] = await Promise.all([
    runBounded("git", ["status", "--short"], { cwd: workspace, timeoutMs: 30_000 }),
    runBounded("git", ["diff", "--binary", "HEAD"], { cwd: workspace, timeoutMs: 30_000, maxOutputBytes: 100 * 1024 * 1024 }),
    runBounded("git", ["diff", "--numstat", "HEAD"], { cwd: workspace, timeoutMs: 30_000 }),
  ]);
  const changedFiles = status.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3));
  const lineStats = numstat.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [added, deleted, ...path] = line.split("\t");
    return { path: path.join("\t"), added: Number(added) || 0, deleted: Number(deleted) || 0 };
  });
  return { status: status.stdout, patch: diff.stdout, changedFiles, lineStats };
}

function defaultPrompt(task) {
  return [
    `Build the complete ${task.product} product described in SPEC.md.`,
    "Start by reading SPEC.md, AGENTS.md, and the visible tests.",
    "Preserve the seeded package entrypoint and visible tests; add tests instead of replacing them, and run the original tests before finishing.",
    "Keep upfront planning short, begin implementation within the first two turns, and reserve output budget for tool calls and verification.",
    "Put finite timeouts around commands that may block, and recover from a stalled test instead of waiting indefinitely.",
    "Maintain a concise REQUIREMENTS.md checklist from every SPEC.md contract; re-read it after compaction and verify every response field and status before finishing.",
    "Work autonomously through implementation and verification. You may add or improve tests, but the independent evaluator is external.",
    "Run the application and exercise important behavior end to end; do not finish merely because files were created.",
    "Finish only when the product is working and npm test passes, or report a concrete blocker after exhausting reasonable fixes.",
  ].join(" ");
}

export function buildPiArgs({ task, model, sessionDirectory, runId }) {
  const args = [
    "--offline",
    "--provider", model.provider,
    "--model", model.model,
    "--thinking", model.thinking ?? "medium",
    "--mode", "json",
    "--print",
    "--session-dir", sessionDirectory,
    "--session-id", runId,
    "--approve",
    "--extension", process.env.BENCH_PI_EXTENSION ?? "/workspace/benchmark/runpod/extensions/bash-timeout.mjs",
    "--tools", "read,bash,edit,write,grep,find,ls",
  ];
  if (model.systemPromptSuffix) args.push("--append-system-prompt", model.systemPromptSuffix);
  args.push(defaultPrompt(task));
  return args;
}

export async function runAttempt({
  root,
  run,
  artifactsRoot,
  piPath = "/workspace/bin/pi",
  agentCommand = null,
  agentArgs = null,
  agentEnv = {},
  telemetryIntervalMs = 2_000,
}) {
  const startedAt = now();
  const started = Date.now();
  const runRoot = resolve(artifactsRoot, "runs", run.runId);
  const workspace = resolve(runRoot, "workspace");
  const sessionDirectory = resolve(runRoot, "sessions");
  await mkdir(runRoot, { recursive: false });
  await mkdir(sessionDirectory, { recursive: true });
  await copyTree(resolve(root, run.task.seedDirectory), workspace);
  await initializeGit(workspace);
  const baselineManifest = await treeManifest(workspace);

  const agentUser = process.env.BENCH_AGENT_USER?.trim();
  if (agentUser) {
    const ownership = await runBounded("chown", ["-R", `${agentUser}:${agentUser}`, workspace, sessionDirectory], {
      timeoutMs: 30_000,
    });
    if (ownership.code !== 0) {
      const permissions = await runBounded("chmod", ["-R", "a+rwX", workspace, sessionDirectory], {
        timeoutMs: 30_000,
      });
      if (permissions.code !== 0) {
        throw new Error(`unable to prepare agent workspace: ${ownership.stderr}\n${permissions.stderr}`);
      }
    }
  }

  let metricsBefore = "";
  try { metricsBefore = await fetchText(run.model.metrics); } catch {}
  const sampler = new TelemetrySampler({ metricsUrl: run.model.metrics, intervalMs: telemetryIntervalMs });
  await sampler.start();

  const piArgs = agentArgs ?? buildPiArgs({ task: run.task, model: run.model, sessionDirectory, runId: run.runId });
  const command = agentCommand ?? (agentUser ? "runuser" : piPath);
  const args = agentCommand
    ? piArgs
    : agentUser
      ? ["--user", agentUser, "--", "env", "PI_OFFLINE=1", "VLLM_API_KEY=local-vllm", piPath, ...piArgs]
      : piArgs;
  const runManifest = await buildRunManifest({ root, run, runRoot, piPath: agentCommand ? null : piPath, piArgs });
  await writeJson(resolve(runRoot, "run-manifest.json"), runManifest);
  const agent = await runBounded(command, args, {
    cwd: workspace,
    env: { ...process.env, PI_OFFLINE: "1", VLLM_API_KEY: "local-vllm", BENCH_SEED: String(run.seed), ...agentEnv },
    timeoutMs: run.task.deadlineSeconds * 1000,
    maxOutputBytes: 250 * 1024 * 1024,
  });
  await sampler.stop();
  await Promise.all([
    writeFile(resolve(runRoot, "agent.jsonl"), agent.stdout, "utf8"),
    writeFile(resolve(runRoot, "agent.stderr.log"), agent.stderr, "utf8"),
    sampler.save(resolve(runRoot, "telemetry.json")),
  ]);

  let metricsAfter = "";
  try { metricsAfter = await fetchText(run.model.metrics); } catch {}
  await writeFile(resolve(runRoot, "vllm-before.prom"), metricsBefore, "utf8");
  await writeFile(resolve(runRoot, "vllm-after.prom"), metricsAfter, "utf8");

  const evidence = await gitEvidence(workspace);
  await writeFile(resolve(runRoot, "changes.patch"), evidence.patch, "utf8");
  const finalManifest = await treeManifest(workspace);
  const sessionText = await findSessionText(sessionDirectory);
  const pi = summarizePiEvents(agent.stdout, sessionText);
  pi.contextWindowUtilization = run.model.contextWindow ? pi.peakContextTokens / run.model.contextWindow : null;

  const gradePath = resolve(runRoot, "grade.json");
  const gradeEventsPath = resolve(runRoot, "evaluator-events.jsonl");
  const evaluatorDiagnosticPath = resolve(runRoot, "evaluator-timeout-diagnostic.json");
  const evaluation = run.task.evaluation;
  const evaluator = await runBounded(process.execPath, [resolve(root, run.task.evaluator)], {
    cwd: root,
    env: {
      ...process.env,
      BENCH_WORKSPACE: workspace,
      BENCH_RUN_ID: run.runId,
      BENCH_CANDIDATE_ID: process.env.BENCH_CANDIDATE_ID ?? "",
      BENCH_TASK_ID: run.task.id,
      BENCH_SEED: String(run.seed ?? ""),
      BENCH_MODEL_ID: run.model.id,
      BENCH_CHECK_DEADLINE_MS: String(evaluation.checkDeadlineSeconds * 1000),
      BENCH_CLEANUP_DEADLINE_MS: String(evaluation.cleanupDeadlineSeconds * 1000),
      BENCH_EVALUATOR_DEADLINE_MS: String(evaluation.outerDeadlineSeconds * 1000),
      GRADE_RESULT_PATH: gradePath,
      GRADE_EVENTS_PATH: gradeEventsPath,
    },
    timeoutMs: evaluation.outerDeadlineSeconds * 1000 + 5_000,
    maxOutputBytes: 20 * 1024 * 1024,
    captureTimeoutDiagnostics: true,
  });
  await writeFile(resolve(runRoot, "evaluator.stdout.log"), redactText(evaluator.stdout, 20 * 1024 * 1024), "utf8");
  await writeFile(resolve(runRoot, "evaluator.stderr.log"), redactText(evaluator.stderr, 20 * 1024 * 1024), "utf8");
  if (evaluator.timeoutDiagnostics) await writeJson(evaluatorDiagnosticPath, evaluator.timeoutDiagnostics);
  let grade = {
    schemaVersion: 2,
    evaluationStatus: "unverified",
    failureOrigin: "unknown",
    finalized: false,
    passed: 0,
    total: 0,
    checks: [],
    error: "evaluator did not emit a result",
  };
  try { grade = JSON.parse(await readFile(gradePath, "utf8")); }
  catch { if (evaluator.stderr) grade.error = redactText(evaluator.stderr.slice(-4_000), 4_000); }

  let classification = grade.total > 0 && grade.passed === grade.total ? "passed" : "failed_acceptance";
  let outcome = grade.evaluationStatus ?? (classification === "passed" ? "pass" : "partial");
  let failureOrigin = grade.failureOrigin ?? (classification === "passed" ? null : "unknown");
  let failureCode = grade.failureCode ?? null;
  if (agent.timedOut) classification = "timeout";
  else if (agent.code !== 0 || !pi.protocolValid) classification = "agent_error";
  if (agent.timedOut) {
    outcome = "timeout";
    failureOrigin = "agent_controller";
    failureCode = "agent_deadline_exceeded";
  } else if (agent.code !== 0 || !pi.protocolValid) {
    outcome = "aborted";
    failureOrigin = "agent_controller";
    failureCode = !pi.protocolValid ? "invalid_agent_protocol" : "agent_nonzero_exit";
  }
  if (evaluator.timedOut || (evaluator.code !== 0 && (!grade.finalized || grade.total === 0))) {
    classification = "infrastructure_error";
    outcome = "unverified";
    failureOrigin = evaluator.timedOut ? "unknown" : (grade.failureOrigin ?? "evaluator");
    failureCode = evaluator.timedOut ? "evaluator_outer_timeout" : "evaluator_incomplete";
  }

  const vllm = summarizeVllmMetrics(metricsBefore, metricsAfter, sampler.metrics.map((sample) => sample.text));
  const result = {
    schemaVersion: 2,
    suiteId: run.suiteId,
    runId: run.runId,
    classification,
    outcome,
    failureOrigin,
    failureCode,
    startedAt,
    finishedAt: now(),
    wallSeconds: Number(((Date.now() - started) / 1000).toFixed(3)),
    task: { id: run.task.id, scale: run.task.scale, product: run.task.product, weight: run.task.weight, deadlineSeconds: run.task.deadlineSeconds, evaluation: run.task.evaluation },
    model: { id: run.model.id, provider: run.model.provider, model: run.model.model, revision: run.model.revision ?? null, gpu: run.model.gpu, thinking: run.model.thinking, contextWindow: run.model.contextWindow },
    agent: { exitCode: agent.code, signal: agent.signal, timedOut: agent.timedOut, outputTruncated: agent.truncated, ...pi },
    grade,
    changes: { changedFiles: evidence.changedFiles, lineStats: evidence.lineStats, baselineFiles: baselineManifest.length, finalFiles: finalManifest.length },
    telemetry: { vllm, gpu: summarizeGpu(sampler.gpu, run.model.gpu), host: summarizeHost(sampler.host), samplerErrors: sampler.errors },
    evaluator: {
      file: basename(run.task.evaluator),
      exitCode: evaluator.code,
      signal: evaluator.signal,
      timedOut: evaluator.timedOut,
      outputTruncated: evaluator.truncated,
      eventsFile: basename(gradeEventsPath),
      timeoutDiagnosticFile: evaluator.timeoutDiagnostics ? basename(evaluatorDiagnosticPath) : null,
    },
  };
  await writeJson(resolve(runRoot, "result.json"), result);
  return result;
}

