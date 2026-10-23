import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRunPlan, budgetRuntimeSeconds, loadConfiguration } from "../src/config.mjs";
import { runBounded } from "../src/process.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hourlyRate = Number(process.env.RUNPOD_HOURLY_RATE_USD ?? 0);
const configuration = await loadConfiguration(root);
const plan = buildRunPlan(configuration);
await access(resolve(root, "dist/bundles/manifest.json"));
const bundleManifest = JSON.parse(await readFile(resolve(root, "dist/bundles/manifest.json"), "utf8"));
if (bundleManifest.tasks.length !== configuration.suite.tasks.length) throw new Error("bundle manifest is incomplete");
for (const task of configuration.suite.tasks) {
  await access(resolve(root, task.evaluator));
  await access(resolve(root, "validation/reference", task.id, "src/server.mjs"));
}
const pi = await runBounded(process.env.PI_PATH ?? "pi", ["--version"], { timeoutMs: 10_000 });
if (pi.code !== 0) throw new Error(`Pi is unavailable: ${pi.stderr}`);
const output = {
  ready: true,
  suiteId: configuration.suite.suiteId,
  experimentId: configuration.experiment.experimentId,
  attempts: plan.length,
  gpuCount: configuration.experiment.gpuCount,
  budgetUsd: configuration.experiment.budgetUsd,
  piVersion: pi.stdout.trim(),
  maxRuntimeSeconds: hourlyRate > 0 ? budgetRuntimeSeconds(configuration.experiment, hourlyRate) : null,
};
console.log(JSON.stringify(output, null, 2));

