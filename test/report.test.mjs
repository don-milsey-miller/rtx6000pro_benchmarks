import assert from "node:assert/strict";
import test from "node:test";
import { renderReport } from "../src/report.mjs";

test("renders a self-contained report with core evidence", () => {
  const html = renderReport({
    metadata: { experimentId: "test", billedUsd: 2 },
    results: [{
      task: { id: "s", product: "A&B", scale: "small", weight: 1 }, model: { id: "qwen" }, classification: "passed", wallSeconds: 10,
      grade: { passed: 2, total: 2 }, agent: { usage: { input: 10, output: 5 }, totalToolCalls: 2, toolErrorRate: 0, compactionCount: 0 },
      telemetry: { vllm: { generationTokens: 5, prefixCache: { hitRate: 0.5 } }, gpu: { utilizationPercent: { mean: 70 } } },
    }],
  });
  assert.match(html, /<!doctype html>/);
  assert.match(html, /A&amp;B/);
  assert.match(html, /Weighted completion/);
  assert.doesNotMatch(html, /<script/);
});

