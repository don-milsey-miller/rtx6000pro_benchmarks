import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeReport } from "../src/report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const input = resolve(process.argv[2] ?? root, process.argv[2] ? "" : "artifacts/results.json");
const output = resolve(process.argv[3] ?? root, process.argv[3] ? "" : "artifacts/report.html");
const data = JSON.parse(await readFile(input, "utf8"));
await writeReport(output, { results: data.results, metadata: data.metadata });
console.log(output);

