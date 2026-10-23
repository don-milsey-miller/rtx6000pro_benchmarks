import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileSha256 } from "./fs.mjs";
import { runBounded } from "./process.mjs";

async function optionalText(path) {
  if (!path) return null;
  try { return (await readFile(path, "utf8")).trim() || null; } catch { return null; }
}

async function optionalJson(path) {
  const text = await optionalText(path);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { parseError: true }; }
}

async function commandText(command, args, options = {}) {
  if (!command) return null;
  try {
    const result = await runBounded(command, args, { ...options, timeoutMs: options.timeoutMs ?? 10_000, maxOutputBytes: 1_000_000 });
    return result.code === 0 ? result.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

async function hashOrNull(path) {
  try { return await fileSha256(path); } catch { return null; }
}

export async function buildRunManifest({ root, run, runRoot, piPath, piArgs = [] }) {
  const [repositoryCommit, piVersion, gpuInventory] = await Promise.all([
    commandText("git", ["rev-parse", "HEAD"], { cwd: root }),
    commandText(piPath, ["--version"]),
    commandText("nvidia-smi", ["--query-gpu=index,name,uuid,driver_version", "--format=csv,noheader"]),
  ]);
  const paths = {
    suite: resolve(root, "config/suite.json"),
    models: resolve(root, "config/models.json"),
    experiment: resolve(root, "config/experiment.json"),
    taskSpec: resolve(root, run.task.seedDirectory, "SPEC.md"),
    evaluator: resolve(root, run.task.evaluator),
    piSettings: resolve(root, "runpod/pi-settings.json"),
    piModels: resolve(root, "runpod/pi-models.json"),
    vllmLaunch: resolve(root, "runpod/launch-stack.sh"),
  };
  const hashes = Object.fromEntries(await Promise.all(
    Object.entries(paths).map(async ([name, path]) => [name, await hashOrNull(path)]),
  ));
  return {
    schemaVersion: 1,
    runId: run.runId,
    candidateId: process.env.BENCH_CANDIDATE_ID ?? null,
    suiteId: process.env.BENCH_SUITE_ID ?? run.suiteId ?? null,
    taskId: run.task.id,
    seed: run.seed ?? null,
    createdAt: new Date().toISOString(),
    repository: {
      commit: repositoryCommit,
      baselineTag: "forgebench-greenfield-v1-baseline",
      baselineCommit: "c76ecd8",
    },
    provenance: {
      suiteSha256: hashes.suite,
      modelsSha256: hashes.models,
      experimentSha256: hashes.experiment,
      taskSpecSha256: hashes.taskSpec,
      evaluatorSha256: hashes.evaluator,
    },
    model: {
      id: run.model.id,
      model: run.model.model,
      revision: run.model.revision ?? null,
      provider: run.model.provider,
      gpu: run.model.gpu,
      contextWindow: run.model.contextWindow ?? null,
      thinking: run.model.thinking ?? null,
      sampling: { temperature: run.model.temperature ?? null, topP: run.model.topP ?? null },
    },
    pi: {
      version: process.env.BENCH_PI_VERSION ?? piVersion,
      settingsSha256: hashes.piSettings,
      modelsSha256: hashes.piModels,
      arguments: piArgs,
    },
    vllm: {
      version: process.env.BENCH_VLLM_VERSION ?? null,
      launchSha256: hashes.vllmLaunch,
      profile: await optionalJson(process.env.BENCH_VLLM_PROFILE_PATH),
    },
    host: {
      imageReference: process.env.BENCH_IMAGE_REFERENCE ?? null,
      imageDigest: process.env.BENCH_IMAGE_DIGEST ?? null,
      os: await optionalText(process.env.BENCH_OS_RELEASE_PATH ?? "/etc/os-release"),
      gpuInventory,
    },
    budgets: {
      agentWallSeconds: run.task.deadlineSeconds,
      evaluatorCheckSeconds: run.task.evaluation.checkDeadlineSeconds,
      evaluatorCleanupSeconds: run.task.evaluation.cleanupDeadlineSeconds,
      evaluatorOuterSeconds: run.task.evaluation.outerDeadlineSeconds,
      repairAttempts: null,
    },
    artifacts: {
      root: runRoot,
      agentTrace: "agent.jsonl",
      workspace: "workspace",
      evaluation: "grade.json",
      evaluationEvents: "evaluator-events.jsonl",
    },
  };
}
