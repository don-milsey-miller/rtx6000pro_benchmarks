const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

const number = (value, digits = 1) => value === null || value === undefined || !Number.isFinite(Number(value))
  ? "—"
  : Number(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const percent = (value, digits = 1) => `${number(Number(value ?? 0) * 100, digits)}%`;
const money = (value) => `$${number(value, 2)}`;

function groupedCompletionChart(models) {
  const width = 760;
  const height = 88 + models.length * 82;
  const left = 130;
  const usable = width - left - 70;
  const rows = models.map((model, index) => {
    const y = 58 + index * 82;
    const baseline = Math.max(0, Math.min(1, Number(model.baseline ?? 0)));
    const optimized = Math.max(0, Math.min(1, Number(model.optimized ?? 0)));
    return `<g>
      <text x="0" y="${y + 24}" class="axis-label">${escape(model.label ?? model.id)}</text>
      <rect x="${left}" y="${y}" width="${usable}" height="24" rx="5" class="track"/>
      <rect x="${left}" y="${y}" width="${usable * baseline}" height="24" rx="5" class="baseline"/>
      <text x="${left + usable + 8}" y="${y + 17}" class="value">${percent(baseline, 0)}</text>
      <rect x="${left}" y="${y + 32}" width="${usable}" height="24" rx="5" class="track"/>
      <rect x="${left}" y="${y + 32}" width="${usable * optimized}" height="24" rx="5" class="optimized"/>
      <text x="${left + usable + 8}" y="${y + 49}" class="value">${percent(optimized, 0)}</text>
    </g>`;
  }).join("");
  return `<figure class="panel chart"><figcaption>Weighted completion by model</figcaption>
    <div class="legend"><span><i class="swatch base"></i>Baseline</span><span><i class="swatch opt"></i>Optimized selection</span></div>
    <svg role="img" aria-label="Weighted task completion before and after optimization" viewBox="0 0 ${width} ${height}">${rows}</svg>
  </figure>`;
}

function efficiencyChart(runs) {
  const width = 760;
  const height = 360;
  const left = 64;
  const top = 28;
  const usableWidth = width - left - 30;
  const usableHeight = height - top - 54;
  const maxTokens = Math.max(1, ...runs.map((run) => Number(run.tokens ?? 0)));
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const grid = ticks.map((tick) => {
    const y = top + usableHeight - usableHeight * tick;
    return `<line x1="${left}" y1="${y}" x2="${left + usableWidth}" y2="${y}" class="grid"/><text x="${left - 10}" y="${y + 4}" text-anchor="end" class="tick">${Math.round(tick * 100)}%</text>`;
  }).join("");
  const points = runs.map((run) => {
    const x = left + Math.sqrt(Number(run.tokens ?? 0) / maxTokens) * usableWidth;
    const y = top + usableHeight - Number(run.completion ?? 0) * usableHeight;
    const radius = 6 + Math.min(12, Math.sqrt(Number(run.wallSeconds ?? 0)) / 4);
    return `<g><circle cx="${x}" cy="${y}" r="${radius}" class="point ${escape(run.model)}"><title>${escape(run.label)}: ${percent(run.completion)}, ${number(run.tokens, 0)} tokens, ${number(Number(run.wallSeconds ?? 0) / 60, 1)} min</title></circle><text x="${x + radius + 4}" y="${y + 4}" class="point-label">${escape(run.shortLabel)}</text></g>`;
  }).join("");
  return `<figure class="panel chart"><figcaption>Completion vs. Pi token work</figcaption><p class="caption">Higher and farther left is better. Bubble radius reflects wall time; the x-axis uses a square-root scale so the Qwen large-run token cost remains visible without flattening every other point.</p>
    <svg role="img" aria-label="Task completion plotted against Pi token count" viewBox="0 0 ${width} ${height}">${grid}<line x1="${left}" y1="${top + usableHeight}" x2="${left + usableWidth}" y2="${top + usableHeight}" class="axis"/><text x="${left + usableWidth / 2}" y="${height - 8}" text-anchor="middle" class="axis-title">Pi tokens → (square-root scale)</text>${points}</svg>
  </figure>`;
}

function outcomeTable(rows) {
  return `<div class="table-wrap"><table><thead><tr><th>Model</th><th>Task</th><th>Baseline</th><th>Selected result</th><th>Wall</th><th>Pi tokens</th><th>Turns</th><th>Prefix hit</th><th>KV peak</th><th>Verdict</th></tr></thead><tbody>${rows.map((row) => `<tr>
    <td><span class="model-pill ${escape(row.model)}">${escape(row.model)}</span></td>
    <td>${escape(row.task)}<small>${escape(row.product)}</small></td>
    <td>${escape(row.baselinePassed)}/${escape(row.total)} <small>${escape(row.baselineClass ?? "")}</small></td>
    <td><strong>${escape(row.optimizedPassed)}/${escape(row.total)}</strong> ${row.repeatRange ? `<small>repeat range ${escape(row.repeatRange)}</small>` : ""}</td>
    <td>${number(Number(row.wallSeconds ?? 0) / 60, 1)} min</td>
    <td>${number(row.tokens, 0)}</td>
    <td>${number(row.turns, 0)}</td>
    <td>${row.prefixHit === null || row.prefixHit === undefined ? "—" : percent(row.prefixHit)}</td>
    <td>${row.kvPeak === null || row.kvPeak === undefined ? "—" : percent(row.kvPeak)}</td>
    <td><span class="verdict ${escape(row.verdict)}">${escape(row.verdict)}</span></td>
  </tr>`).join("")}</tbody></table></div>`;
}

function proseCards(items, className = "") {
  return `<div class="prose-grid ${escape(className)}">${items.map((item) => `<article class="panel"><h3>${escape(item.title)}</h3>${item.metric ? `<p class="big-metric">${escape(item.metric)}</p>` : ""}<p>${escape(item.body)}</p>${item.details?.length ? `<ul>${item.details.map((detail) => `<li>${escape(detail)}</li>`).join("")}</ul>` : ""}</article>`).join("")}</div>`;
}

function sequence(items) {
  return `<ol class="sequence">${items.map((item, index) => `<li><span>${index + 1}</span><div><h3>${escape(item.title)}</h3><p>${escape(item.body)}</p>${item.exit ? `<p class="exit"><strong>Exit gate:</strong> ${escape(item.exit)}</p>` : ""}</div></li>`).join("")}</ol>`;
}

function sourceList(items) {
  return items.map((item) => `<li><a href="${escape(item.url)}">${escape(item.label)}</a><span>${escape(item.note ?? "")}</span></li>`).join("");
}

export function renderResearchReport(data) {
  const generatedAt = data.generatedAt ?? new Date().toISOString();
  const cards = [
    ["Optimized weighted completion", percent(data.summary.optimizedCompletion)],
    ["Baseline weighted completion", percent(data.summary.baselineCompletion)],
    ["Full task passes", `${data.summary.fullPasses} / ${data.summary.selectedAttempts}`],
    ["RunPod spend", money(data.cost.totalUsd)],
    ["Budget remaining", money(data.cost.budgetUsd - data.cost.totalUsd)],
    ["Paid pod duration", `${number(data.cost.podHours, 2)} h`],
  ].map(([label, value]) => `<div class="card"><span>${escape(label)}</span><strong>${escape(value)}</strong></div>`).join("");

  const experimentRows = data.experiments.map((entry) => `<tr><td><code>${escape(entry.id)}</code></td><td>${escape(entry.change)}</td><td>${escape(entry.result)}</td><td><span class="status ${escape(entry.status)}">${escape(entry.status)}</span></td><td>${escape(entry.why)}</td></tr>`).join("");
  const telemetryRows = data.telemetry.map((row) => `<tr><td><span class="model-pill ${escape(row.model)}">${escape(row.model)}</span></td><td>${number(row.tpotSeconds, 4)}s</td><td>${number(row.ttftP95Seconds, 2)}s</td><td>${percent(row.prefixHit)}</td><td>${percent(row.kvPeak)}</td><td>${number(row.gpuUtilization, 1)}%</td><td>${number(row.powerMeanW, 0)} W</td><td>${number(row.waitingMax, 0)}</td><td>${number(row.preemptions, 0)}</td></tr>`).join("");
  const artifactRows = data.artifacts.map((artifact) => `<tr><td><code>${escape(artifact.path)}</code></td><td>${escape(artifact.contents)}</td><td>${escape(artifact.retention)}</td></tr>`).join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escape(data.title)}</title><style>
  :root{color-scheme:dark;--bg:#061018;--panel:#0f1d28;--panel2:#132635;--line:#294052;--text:#e9f1f5;--muted:#9db0bd;--green:#66e3b4;--blue:#70a7ff;--orange:#ffb86b;--red:#ff7383;--purple:#c792ea}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 14% -8%,#19425a 0,transparent 34%),radial-gradient(circle at 95% 10%,#202650 0,transparent 27%),var(--bg);color:var(--text);font:15px/1.58 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:1480px;margin:auto;padding:42px 28px 80px}a{color:#8bc1ff}h1{font-size:clamp(34px,5vw,62px);line-height:1.04;letter-spacing:-.035em;max-width:1050px;margin:0}h2{font-size:28px;margin:52px 0 18px;letter-spacing:-.02em}h3{font-size:17px;margin:0 0 8px}.kicker{color:var(--green);text-transform:uppercase;letter-spacing:.14em;font-weight:700;font-size:12px}.lede{font-size:19px;max-width:970px;color:#c7d6df}.meta,.caption,small{color:var(--muted)}.meta{font-family:ui-monospace,SFMono-Regular,monospace}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:28px 0}.card,.panel,.callout{background:linear-gradient(145deg,rgba(19,38,53,.96),rgba(12,27,38,.96));border:1px solid var(--line);border-radius:14px;padding:20px;box-shadow:0 14px 40px rgba(0,0,0,.13)}.card span{color:var(--muted);display:block}.card strong{font-size:27px;display:block;margin-top:6px}.callout{border-left:4px solid var(--green);font-size:17px}.danger{border-left-color:var(--orange)}.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(520px,1fr));gap:14px}.chart{margin:0;overflow:hidden}.chart figcaption{font-weight:750;font-size:18px}.chart svg{width:100%;height:auto;margin-top:8px}.track{fill:#243747}.baseline{fill:var(--orange)}.optimized{fill:var(--green)}.axis-label,.value,.tick,.point-label,.axis-title{fill:var(--text);font:14px system-ui}.tick,.point-label{fill:var(--muted);font-size:12px}.grid{stroke:#294052;stroke-width:1}.axis{stroke:#607b8f;stroke-width:1.5}.point{stroke:#061018;stroke-width:2;opacity:.9}.point.qwen{fill:var(--blue)}.point.muse{fill:var(--green)}.point.gemma{fill:var(--purple)}.legend{display:flex;gap:18px;color:var(--muted);font-size:13px;margin-top:6px}.swatch{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}.swatch.base{background:var(--orange)}.swatch.opt{background:var(--green)}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:14px;background:rgba(12,27,38,.96)}table{border-collapse:collapse;width:100%;min-width:1050px}th,td{padding:12px 14px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);position:sticky;top:0;background:#102330}td small{display:block}.model-pill,.verdict,.status{display:inline-block;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:750;text-transform:uppercase;letter-spacing:.04em}.model-pill.qwen{background:#173a66;color:#9fc8ff}.model-pill.muse{background:#173e35;color:#8aefc9}.model-pill.gemma{background:#39254c;color:#d7a9f2}.verdict.pass,.status.keep{background:#173e35;color:#8aefc9}.verdict.near-pass,.status.mixed{background:#4a361c;color:#ffd08d}.verdict.fail,.status.discard,.status.crash{background:#4b2028;color:#ff9baa}.status.infrastructure{background:#253947;color:#b8ccda}.prose-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:14px}.prose-grid p,.prose-grid li{color:#bfced7}.big-metric{font-size:27px!important;color:var(--text)!important;margin:2px 0 8px}.sequence{list-style:none;padding:0;margin:0;display:grid;gap:12px}.sequence li{display:grid;grid-template-columns:42px 1fr;gap:14px;padding:18px;border:1px solid var(--line);background:var(--panel);border-radius:13px}.sequence>li>span{width:36px;height:36px;display:grid;place-items:center;border-radius:50%;background:#173a45;color:var(--green);font-weight:800}.sequence p{margin:4px 0;color:#bfced7}.sequence .exit{color:var(--text)}.sources{columns:2;column-gap:32px}.sources li{break-inside:avoid;margin:0 0 14px}.sources span{display:block;color:var(--muted)}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:#cfe5f2}.footer{margin-top:48px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted)}@media(max-width:760px){main{padding:28px 16px 60px}.charts{grid-template-columns:1fr}.sources{columns:1}}
  </style></head><body><main>
  <p class="kicker">RHEL 10 · 3× RTX PRO 6000 Blackwell · vLLM + Pi</p>
  <h1>${escape(data.title)}</h1>
  <p class="lede">${escape(data.subtitle)}</p>
  <p class="meta">Generated ${escape(generatedAt)} · commit ${escape(data.commit)} · suite ${escape(data.suiteId)}</p>
  <div class="cards">${cards}</div>
  <div class="callout"><strong>Decision:</strong> ${escape(data.decision)}</div>

  <h2>What changed</h2>${proseCards(data.executiveFindings)}
  <h2>Measured outcome</h2><div class="charts">${groupedCompletionChart(data.modelCompletion)}${efficiencyChart(data.efficiencyRuns)}</div>
  <h2>Capability matrix</h2>${outcomeTable(data.outcomes)}
  <div class="callout danger"><strong>Important qualification:</strong> ${escape(data.qualification)}</div>

  <h2>Why attempts failed</h2>${proseCards(data.failureModes, "failures")}
  <h2>Serving and hardware telemetry</h2><div class="table-wrap"><table><thead><tr><th>Model</th><th>Mean TPOT</th><th>TTFT p95</th><th>Prefix hit</th><th>KV peak</th><th>GPU util</th><th>Mean power</th><th>Waiting max</th><th>Preemptions</th></tr></thead><tbody>${telemetryRows}</tbody></table></div>
  <p class="caption">Metrics are per selected run unless explicitly identified as shared/contaminated. Raw Prometheus snapshots and two-second GPU samples are retained.</p>

  <h2>Experiment log</h2><div class="table-wrap"><table><thead><tr><th>ID</th><th>Change</th><th>Observed result</th><th>Status</th><th>Reason</th></tr></thead><tbody>${experimentRows}</tbody></table></div>
  <h2>Technical strategy</h2>${sequence(data.strategy)}
  <h2>Bare-metal transfer plan</h2>${sequence(data.migration)}
  <h2>Method, boundaries, and caveats</h2>${proseCards(data.methodNotes)}
  <h2>Artifact inventory</h2><div class="table-wrap"><table><thead><tr><th>Path</th><th>Contents</th><th>Retention / use</th></tr></thead><tbody>${artifactRows}</tbody></table></div>
  <h2>Primary references</h2><ul class="sources">${sourceList(data.sources)}</ul>
  <p class="footer">This report is self-contained; it embeds no remote scripts, fonts, analytics, credentials, or model output. Numerical conclusions are derived from the retained ForgeBench result JSON and raw telemetry artifacts.</p>
  </main></body></html>`;
}
