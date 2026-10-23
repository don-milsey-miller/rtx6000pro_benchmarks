import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { writeJson } from "../src/fs.mjs";
import { writeReport } from "../src/report.mjs";
import { scoreSuite } from "../src/score.mjs";

const artifactsRoot = resolve(process.argv[2] ?? process.env.BENCH_ARTIFACTS ?? "artifacts");
const runsRoot = resolve(artifactsRoot, "runs");
const results = [];

for (const entry of await readdir(runsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  try {
    results.push(JSON.parse(await readFile(resolve(runsRoot, entry.name, "result.json"), "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

if (!results.length) throw new Error(`no completed runs found under ${runsRoot}`);
results.sort((a, b) => a.runId.localeCompare(b.runId));
const metadata = {
  experimentId: process.env.BENCH_EXPERIMENT_ID ?? "aggregated-research-run",
  generatedAt: new Date().toISOString(),
  profile: process.env.BENCH_PROFILE ?? "candidate",
  billedUsd: Number(process.env.BENCH_BILLED_USD ?? 0),
  aggregated: true,
};
const output = { schemaVersion: 1, metadata, summary: scoreSuite(results, metadata.billedUsd), results };
await writeJson(resolve(artifactsRoot, "results.json"), output);
await writeReport(resolve(artifactsRoot, "report.html"), output);
console.log(JSON.stringify(output.summary, null, 2));
