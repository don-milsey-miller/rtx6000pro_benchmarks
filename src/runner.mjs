import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { copyTree, treeManifest, writeJson } from "./fs.mjs";
import { summarizePiEvents } from "./pi-events.mjs";
import { runBounded } from "./process.mjs";
import { summarizeVllmMetrics } from "./prometheus.mjs";
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
    "Keep upfront planning short, begin implementation within the first two turns, and reserve output budget for tool calls and verification.",
    "Put finite timeouts around commands that may block, and recover from a stalled test instead of waiting indefinitely.",
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
  const agent = await runBounded(command, args, {
    cwd: workspace,
    env: { ...process.env, PI_OFFLINE: "1", VLLM_API_KEY: "local-vllm", ...agentEnv },
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
  const evaluator = await runBounded(process.execPath, [resolve(root, run.task.evaluator)], {
    cwd: root,
    env: { ...process.env, BENCH_WORKSPACE: workspace, GRADE_RESULT_PATH: gradePath },
    timeoutMs: 180_000,
    maxOutputBytes: 20 * 1024 * 1024,
  });
  await writeFile(resolve(runRoot, "evaluator.stdout.log"), evaluator.stdout, "utf8");
  await writeFile(resolve(runRoot, "evaluator.stderr.log"), evaluator.stderr, "utf8");
  let grade = { passed: 0, total: 0, checks: [], error: "evaluator did not emit a result" };
  try { grade = JSON.parse(await readFile(gradePath, "utf8")); }
  catch { if (evaluator.stderr) grade.error = evaluator.stderr.slice(-4_000); }

  let classification = grade.total > 0 && grade.passed === grade.total ? "passed" : "failed_acceptance";
  if (agent.timedOut) classification = "timeout";
  else if (agent.code !== 0 || !pi.protocolValid) classification = "agent_error";
  if (evaluator.timedOut || (evaluator.code !== 0 && grade.total === 0)) classification = "infrastructure_error";

  const vllm = summarizeVllmMetrics(metricsBefore, metricsAfter, sampler.metrics.map((sample) => sample.text));
  const result = {
    schemaVersion: 1,
    suiteId: "forgebench-v1",
    runId: run.runId,
    classification,
    startedAt,
    finishedAt: now(),
    wallSeconds: Number(((Date.now() - started) / 1000).toFixed(3)),
    task: { id: run.task.id, scale: run.task.scale, product: run.task.product, weight: run.task.weight, deadlineSeconds: run.task.deadlineSeconds },
    model: { id: run.model.id, provider: run.model.provider, model: run.model.model, gpu: run.model.gpu, thinking: run.model.thinking, contextWindow: run.model.contextWindow },
    agent: { exitCode: agent.code, signal: agent.signal, timedOut: agent.timedOut, outputTruncated: agent.truncated, ...pi },
    grade,
    changes: { changedFiles: evidence.changedFiles, lineStats: evidence.lineStats, baselineFiles: baselineManifest.length, finalFiles: finalManifest.length },
    telemetry: { vllm, gpu: summarizeGpu(sampler.gpu, run.model.gpu), host: summarizeHost(sampler.host), samplerErrors: sampler.errors },
    evaluator: { file: basename(run.task.evaluator), exitCode: evaluator.code, timedOut: evaluator.timedOut },
  };
  await writeJson(resolve(runRoot, "result.json"), result);
  return result;
}

