import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRunPlan, loadConfiguration } from "../src/config.mjs";
import { writeJson } from "../src/fs.mjs";
import { writeReport } from "../src/report.mjs";
import { runAttempt } from "../src/runner.mjs";
import { scoreSuite } from "../src/score.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsRoot = resolve(process.env.BENCH_ARTIFACTS ?? root, process.env.BENCH_ARTIFACTS ? "" : "artifacts");
const configuration = await loadConfiguration(root);
const plan = buildRunPlan(configuration);
await mkdir(resolve(artifactsRoot, "runs"), { recursive: true });
const piPath = process.env.PI_PATH ?? "/workspace/pi/node_modules/.bin/pi";
const results = [];
const groups = new Map(configuration.models.models.map((model) => [model.id, []]));
for (const run of plan) groups.get(run.model.id).push(run);
await Promise.all([...groups.values()].map(async (runs) => {
  for (const run of runs) {
    const result = await runAttempt({ root, run, artifactsRoot, piPath });
    results.push(result);
    await writeJson(resolve(artifactsRoot, "partial-summary.json"), scoreSuite(results));
  }
}));
results.sort((a, b) => a.runId.localeCompare(b.runId));
const metadata = {
  experimentId: configuration.experiment.experimentId,
  generatedAt: new Date().toISOString(),
  profile: configuration.experiment.profile,
  billedUsd: Number(process.env.BENCH_BILLED_USD ?? 0),
};
await writeJson(resolve(artifactsRoot, "results.json"), { schemaVersion: 1, metadata, summary: scoreSuite(results, metadata.billedUsd), results });
await writeReport(resolve(artifactsRoot, "report.html"), { results, metadata });
console.log(JSON.stringify(scoreSuite(results, metadata.billedUsd), null, 2));

