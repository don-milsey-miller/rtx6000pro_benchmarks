function parseLabels(raw = "") {
  const labels = {};
  const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"])*)"/g;
  for (const match of raw.matchAll(pattern)) labels[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\n/g, "\n");
  return labels;
}

export function parsePrometheus(text) {
  const samples = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([^\s{]+)(?:\{(.*)\})?\s+([^\s]+)(?:\s+\d+)?$/);
    if (!match) continue;
    const value = Number(match[3]);
    if (Number.isNaN(value)) continue;
    samples.push({ name: match[1], labels: parseLabels(match[2]), value });
  }
  return samples;
}

function keyOf(sample, ignoredLabels = []) {
  const labels = Object.entries(sample.labels).filter(([key]) => !ignoredLabels.includes(key)).sort(([a], [b]) => a.localeCompare(b));
  return `${sample.name}|${JSON.stringify(labels)}`;
}

export function counterDelta(before, after, name) {
  const previous = new Map(before.filter((sample) => sample.name === name).map((sample) => [keyOf(sample), sample.value]));
  return after.filter((sample) => sample.name === name).reduce((sum, sample) => sum + Math.max(0, sample.value - (previous.get(keyOf(sample)) ?? 0)), 0);
}

export function gaugeValues(samples, name) {
  return samples.filter((sample) => sample.name === name).map((sample) => sample.value);
}

function histogram(before, after, base) {
  const count = counterDelta(before, after, `${base}_count`);
  const sum = counterDelta(before, after, `${base}_sum`);
  const beforeBuckets = new Map(before.filter((sample) => sample.name === `${base}_bucket`).map((sample) => [keyOf(sample, ["le"]), sample]));
  const buckets = new Map();
  for (const sample of after.filter((candidate) => candidate.name === `${base}_bucket`)) {
    const group = keyOf(sample, ["le"]);
    const old = beforeBuckets.get(group);
    const delta = Math.max(0, sample.value - (old?.value ?? 0));
    const le = sample.labels.le === "+Inf" ? Infinity : Number(sample.labels.le);
    buckets.set(le, (buckets.get(le) ?? 0) + delta);
  }
  const quantile = (q) => {
    if (!count) return null;
    const target = count * q;
    for (const [le, cumulative] of [...buckets.entries()].sort(([a], [b]) => a - b)) if (cumulative >= target) return Number.isFinite(le) ? le : null;
    return null;
  };
  return { count, mean: count ? sum / count : null, p50: quantile(0.5), p95: quantile(0.95), p99: quantile(0.99) };
}

function existingName(samples, candidates) {
  return candidates.find((name) => samples.some((sample) => sample.name.startsWith(name))) ?? candidates[0];
}

export function summarizeVllmMetrics(beforeText, afterText, sampleTexts = []) {
  const before = parsePrometheus(beforeText);
  const after = parsePrometheus(afterText);
  const all = [...before, ...after];
  const name = (candidates) => existingName(all, candidates);
  const promptName = name(["vllm:prompt_tokens_total", "vllm_prompt_tokens_total"]);
  const generationName = name(["vllm:generation_tokens_total", "vllm_generation_tokens_total"]);
  const prefixQueries = name([
    "vllm:prefix_cache_queries_total",
    "vllm_prefix_cache_queries_total",
    "vllm:prefix_cache_queries",
    "vllm_prefix_cache_queries",
  ]);
  const prefixHits = name([
    "vllm:prefix_cache_hits_total",
    "vllm_prefix_cache_hits_total",
    "vllm:prefix_cache_hits",
    "vllm_prefix_cache_hits",
  ]);
  const preemptions = name(["vllm:num_preemptions_total", "vllm_num_preemptions_total"]);
  const ttft = name(["vllm:time_to_first_token_seconds", "vllm_time_to_first_token_seconds"]);
  const tpot = name([
    "vllm:request_time_per_output_token_seconds",
    "vllm_request_time_per_output_token_seconds",
    "vllm:time_per_output_token_seconds",
    "vllm_time_per_output_token_seconds",
  ]);
  const e2e = name(["vllm:e2e_request_latency_seconds", "vllm_e2e_request_latency_seconds"]);
  const requests = name(["vllm:request_success_total", "vllm_request_success_total"]);
  const failures = name(["vllm:request_failure_total", "vllm_request_failure_total"]);
  const parsedSamples = sampleTexts.map(parsePrometheus);
  const gauge = (candidates) => {
    const metric = existingName(parsedSamples.flat(), candidates);
    const values = parsedSamples.flatMap((samples) => gaugeValues(samples, metric));
    return values.length ? { mean: values.reduce((a, b) => a + b, 0) / values.length, max: Math.max(...values) } : { mean: null, max: null };
  };
  const queries = counterDelta(before, after, prefixQueries);
  const hits = counterDelta(before, after, prefixHits);
  return {
    promptTokens: counterDelta(before, after, promptName),
    generationTokens: counterDelta(before, after, generationName),
    successfulRequests: counterDelta(before, after, requests),
    failedRequests: counterDelta(before, after, failures),
    preemptions: counterDelta(before, after, preemptions),
    prefixCache: { queries, hits, hitRate: queries ? hits / queries : null },
    latencySeconds: {
      ttft: histogram(before, after, ttft),
      tpot: histogram(before, after, tpot),
      e2e: histogram(before, after, e2e),
    },
    kvCacheUsage: gauge(["vllm:kv_cache_usage_perc", "vllm_kv_cache_usage_perc"]),
    runningRequests: gauge(["vllm:num_requests_running", "vllm_num_requests_running"]),
    waitingRequests: gauge(["vllm:num_requests_waiting", "vllm_num_requests_waiting"]),
  };
}

