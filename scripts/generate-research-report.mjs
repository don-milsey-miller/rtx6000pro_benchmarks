import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { renderResearchReport } from "../src/research-report.mjs";

const [inputArgument, outputArgument] = process.argv.slice(2);
if (!inputArgument || !outputArgument) {
  console.error("Usage: node scripts/generate-research-report.mjs <summary.json> <report.html>");
  process.exit(2);
}

const input = resolve(inputArgument);
const output = resolve(outputArgument);
const data = JSON.parse(await readFile(input, "utf8"));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, renderResearchReport(data), "utf8");
console.log(output);
