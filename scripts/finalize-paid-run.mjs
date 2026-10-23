import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeJson } from "../src/fs.mjs";
import { writeReport } from "../src/report.mjs";
import { scoreSuite } from "../src/score.mjs";

const resultsPath = resolve(process.argv[2]);
const reportPath = resolve(process.argv[3]);
const data = JSON.parse(await readFile(resultsPath, "utf8"));
const billedUsd = Number(process.env.BENCH_BILLED_USD ?? 0);
data.metadata = {
  ...data.metadata,
  finalizedAt: new Date().toISOString(),
  billedUsd,
  provider: {
    name: "RunPod",
    podId: process.env.BENCH_RUNPOD_POD_ID ?? null,
    hourlyRateUsd: Number(process.env.BENCH_RUNPOD_HOURLY_RATE ?? 0),
    elapsedHours: Number(process.env.BENCH_RUNPOD_ELAPSED_HOURS ?? 0),
  },
};
data.summary = scoreSuite(data.results, billedUsd);
await writeJson(resultsPath, data);
await writeReport(reportPath, { results: data.results, metadata: data.metadata });
console.log(reportPath);
