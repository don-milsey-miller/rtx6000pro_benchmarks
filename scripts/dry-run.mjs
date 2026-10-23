import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRunPlan, loadConfiguration } from "../src/config.mjs";
import { runAttempt } from "../src/runner.mjs";
import { scoreSuite } from "../src/score.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configuration = await loadConfiguration(root);
const plan = buildRunPlan(configuration).filter((run) => run.model.id === configuration.models.models[0].id);
const temp = await mkdtemp(join(tmpdir(), "forgebench-dry-"));
const artifacts = resolve(temp, "artifacts");
await mkdir(resolve(artifacts, "runs"), { recursive: true });
const results = [];
try {
  for (const run of plan) {
    results.push(await runAttempt({
      root,
      run,
      artifactsRoot: artifacts,
      agentCommand: process.execPath,
      agentArgs: [resolve(root, "scripts/mock-agent.mjs")],
      agentEnv: { MOCK_REFERENCE: resolve(root, "validation/reference", run.task.id), MOCK_RUN_ID: run.runId },
      telemetryIntervalMs: 50,
    }));
  }
  if (results.some((result) => result.classification !== "passed")) throw new Error(`dry run failed: ${JSON.stringify(results.map(({ runId, classification }) => ({ runId, classification })))}`);
  if (results.some((result) => !result.changes.changedFiles.length || !result.changes.lineStats.length)) {
    throw new Error("dry run failed to preserve untracked-file Git evidence");
  }
  console.log(JSON.stringify(scoreSuite(results), null, 2));
  console.log("end-to-end dry run passed");
} finally {
  await rm(temp, { recursive: true, force: true });
}

