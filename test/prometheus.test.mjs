import assert from "node:assert/strict";
import test from "node:test";
import { parsePrometheus, summarizeVllmMetrics } from "../src/prometheus.mjs";

const before = `
vllm:prompt_tokens_total{model_name="demo"} 100
vllm:generation_tokens_total{model_name="demo"} 50
vllm:prefix_cache_queries{model_name="demo"} 20
vllm:prefix_cache_hits{model_name="demo"} 5
vllm:time_to_first_token_seconds_bucket{model_name="demo",le="0.1"} 1
vllm:time_to_first_token_seconds_bucket{model_name="demo",le="0.5"} 2
vllm:time_to_first_token_seconds_bucket{model_name="demo",le="+Inf"} 2
vllm:time_to_first_token_seconds_sum{model_name="demo"} 0.4
vllm:time_to_first_token_seconds_count{model_name="demo"} 2
`;
const after = `
vllm:prompt_tokens_total{model_name="demo"} 250
vllm:generation_tokens_total{model_name="demo"} 90
vllm:prefix_cache_queries{model_name="demo"} 30
vllm:prefix_cache_hits{model_name="demo"} 9
vllm:time_to_first_token_seconds_bucket{model_name="demo",le="0.1"} 2
vllm:time_to_first_token_seconds_bucket{model_name="demo",le="0.5"} 5
vllm:time_to_first_token_seconds_bucket{model_name="demo",le="+Inf"} 5
vllm:time_to_first_token_seconds_sum{model_name="demo"} 1.4
vllm:time_to_first_token_seconds_count{model_name="demo"} 5
`;

test("parses Prometheus labels and values", () => {
  const samples = parsePrometheus(before);
  assert.equal(samples[0].labels.model_name, "demo");
  assert.equal(samples[0].value, 100);
});

test("computes counters, cache rate, histogram, and gauges", () => {
  const summary = summarizeVllmMetrics(before, after, ["vllm:kv_cache_usage_perc 0.2", "vllm:kv_cache_usage_perc 0.8"]);
  assert.equal(summary.promptTokens, 150);
  assert.equal(summary.generationTokens, 40);
  assert.equal(summary.prefixCache.queries, 10);
  assert.equal(summary.prefixCache.hits, 4);
  assert.equal(summary.prefixCache.hitRate, 0.4);
  assert.equal(summary.latencySeconds.ttft.count, 3);
  assert.equal(summary.latencySeconds.ttft.mean, 1 / 3);
  assert.equal(summary.latencySeconds.ttft.p95, 0.5);
  assert.equal(summary.kvCacheUsage.max, 0.8);
});

