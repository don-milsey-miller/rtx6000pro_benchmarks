import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { scoreAttempt, scoreSuite } from "./score.mjs";

const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const percent = (value) => `${(Number(value ?? 0) * 100).toFixed(1)}%`;
const number = (value, digits = 1) => value === null || value === undefined ? "—" : Number(value).toFixed(digits);

function bar(value, color = "#66e3b4") {
  const width = Math.max(0, Math.min(100, Number(value ?? 0) * 100));
  return `<div class="bar"><span style="width:${width}%;background:${color}"></span></div>`;
}

function modelSummary(results) {
  const groups = new Map();
  for (const result of results) {
    const group = groups.get(result.model.id) ?? { id: result.model.id, weighted: 0, weight: 0, wallSeconds: 0, tokens: 0, tools: 0, attempts: 0 };
    const score = scoreAttempt(result);
    group.weighted += score.weightedCompletion;
    group.weight += Number(result.task.weight ?? 0);
    group.wallSeconds += Number(result.wallSeconds ?? 0);
    group.tokens += Number(result.agent?.usage?.total ?? 0);
    group.tools += Number(result.agent?.totalToolCalls ?? 0);
    group.attempts += 1;
    groups.set(result.model.id, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    completion: group.weight ? group.weighted / group.weight : 0,
    wallMinutes: group.wallSeconds / 60,
  })).sort((a, b) => a.id.localeCompare(b.id));
}

function svgBars(items, { title, value, format, color = "#66e3b4", max = null }) {
  const width = 620;
  const labelWidth = 110;
  const right = 80;
  const rowHeight = 42;
  const chartHeight = Math.max(1, items.length) * rowHeight;
  const ceiling = max ?? Math.max(1, ...items.map(value));
  const bars = items.map((item, index) => {
    const y = 42 + index * rowHeight;
    const raw = Number(value(item) ?? 0);
    const barWidth = Math.max(0, Math.min(width - labelWidth - right, (raw / ceiling) * (width - labelWidth - right)));
    return `<text x="0" y="${y + 16}" fill="#e8f1f7">${escape(item.id)}</text><rect x="${labelWidth}" y="${y}" width="${width - labelWidth - right}" height="22" rx="5" fill="#263645"/><rect x="${labelWidth}" y="${y}" width="${barWidth}" height="22" rx="5" fill="${color}"/><text x="${width - 2}" y="${y + 16}" text-anchor="end" fill="#e8f1f7">${escape(format(raw))}</text>`;
  }).join("");
  return `<figure><figcaption>${escape(title)}</figcaption><svg role="img" aria-label="${escape(title)}" viewBox="0 0 ${width} ${chartHeight + 54}">${bars}</svg></figure>`;
}

export function renderReport({ results, metadata = {} }) {
  const summary = scoreSuite(results, Number(metadata.billedUsd ?? 0));
  const byModel = modelSummary(results);
  const rows = results.map((result) => {
    const score = scoreAttempt(result);
    const vllm = result.telemetry?.vllm ?? {};
    return `<tr>
      <td>${escape(result.task.product)}<small>${escape(result.task.scale)}</small></td>
      <td>${escape(result.model.id)}</td>
      <td><strong>${percent(score.completion)}</strong>${bar(score.completion, score.passed ? "#66e3b4" : "#ffb86b")}</td>
      <td>${escape(result.classification)}</td>
      <td>${number(result.wallSeconds, 0)}s</td>
      <td>${number(result.agent?.usage?.input, 0)} / ${number(result.agent?.usage?.output, 0)}</td>
      <td>${number(result.agent?.totalToolCalls, 0)} (${percent(result.agent?.toolErrorRate)})</td>
      <td>${number(result.agent?.compactionCount, 0)}</td>
      <td>${percent(result.agent?.contextWindowUtilization)}</td>
      <td>${number(vllm.latencySeconds?.ttft?.p95, 3)}s</td>
      <td>${percent(vllm.kvCacheUsage?.max)}</td>
      <td>${percent(vllm.prefixCache?.hitRate)}</td>
      <td>${number(result.telemetry?.gpu?.utilizationPercent?.mean)}%</td>
    </tr>`;
  }).join("\n");
  const cards = [
    ["Weighted completion", percent(summary.weightedCompletion)],
    ["Full passes", `${summary.fullPasses} / ${summary.attempts}`],
    ["Agent wall time", `${number(summary.totalAgentWallHours, 2)} h`],
    ["Provider cost", metadata.billedUsd ? `$${number(metadata.billedUsd, 2)}` : "pending"],
    ["Work / dollar", number(summary.weightedWorkPerDollar, 2)],
  ].map(([label, value]) => `<div class="card"><span>${escape(label)}</span><strong>${escape(value)}</strong></div>`).join("");
  const charts = [
    svgBars(byModel, { title: "Weighted completion by model", value: (item) => item.completion, format: percent, max: 1, color: "#66e3b4" }),
    svgBars(byModel, { title: "Total agent wall time by model", value: (item) => item.wallMinutes, format: (value) => `${number(value, 1)} min`, color: "#70a7ff" }),
    svgBars(byModel, { title: "Pi tokens by model", value: (item) => item.tokens, format: (value) => number(value, 0), color: "#c792ea" }),
  ].join("");
  const notes = (metadata.changeLog ?? [
    "Replaced the Kiln benchmark with greenfield product construction tasks.",
    "Removed Windows CI; execution and grading are Linux-only.",
    "Separated task correctness, Pi behavior, vLLM telemetry, GPU telemetry, and provider cost.",
    "Pinned model revisions and isolated hidden graders from the agent user.",
  ]).map((note) => `<li>${escape(note)}</li>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ForgeBench ${escape(metadata.experimentId ?? "report")}</title><style>
:root{color-scheme:dark;--bg:#071019;--panel:#101d29;--line:#26394a;--text:#e8f1f7;--muted:#94a9b8;--accent:#66e3b4}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% -10%,#17364a 0,transparent 40%),var(--bg);font:14px/1.5 system-ui;color:var(--text)}main{max-width:1500px;margin:auto;padding:40px 24px}h1{font-size:38px;margin:0}h2{margin-top:34px}p{color:var(--muted)}.meta{font-family:ui-monospace,monospace}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:28px 0}.card,figure,.note,.changes{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px}.card span{display:block;color:var(--muted)}.card strong{display:block;font-size:25px;margin-top:7px}.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px}.charts figure{margin:0}.charts figcaption{font-weight:700;margin-bottom:8px}.charts svg{width:100%;height:auto}.table{overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:12px}table{width:100%;border-collapse:collapse;min-width:1450px}th,td{padding:12px;text-align:left;border-bottom:1px solid var(--line)}th{color:var(--muted);font-size:12px;text-transform:uppercase}td small{display:block;color:var(--muted)}.bar{height:5px;width:100px;background:#263645;border-radius:5px;overflow:hidden;margin-top:5px}.bar span{display:block;height:100%}.note{margin-top:24px;border-left:3px solid var(--accent)}.changes li{margin:7px 0;color:var(--muted)}
</style></head><body><main><h1>ForgeBench</h1><p class="meta">${escape(metadata.experimentId ?? "unidentified experiment")} · ${escape(metadata.generatedAt ?? new Date().toISOString())} · Linux-only product creation</p><div class="cards">${cards}</div>
<h2>Comparative view</h2><div class="charts">${charts}</div>
<h2>Agent task outcomes</h2><div class="table"><table><thead><tr><th>Product</th><th>Model</th><th>Completion</th><th>Class</th><th>Wall</th><th>Input / output tokens</th><th>Tools (error)</th><th>Compactions</th><th>Peak context</th><th>TTFT p95</th><th>KV peak</th><th>Prefix hit</th><th>GPU util</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="note"><strong>Interpretation rule:</strong> correctness is a hard gate. Throughput, latency, or cost improvements do not make an incomplete product a winning configuration.</div>
<h2>Change log and experimental boundaries</h2><div class="changes"><ul>${notes}</ul><p>Model ranking is provisional when a cell has fewer than three repetitions. All raw Pi streams, sessions, patches, grader results, Prometheus snapshots, and host/GPU samples remain in the artifact bundle.</p></div>
</main></body></html>`;
}

export async function writeReport(path, input) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderReport(input), "utf8");
}

