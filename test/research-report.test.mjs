import assert from "node:assert/strict";
import test from "node:test";
import { renderResearchReport } from "../src/research-report.mjs";

test("research report is self-contained and escapes supplied fields", () => {
  const html = renderResearchReport({
    title: "A <report>", subtitle: "Evidence", generatedAt: "now", commit: "abc", suiteId: "suite", decision: "keep",
    summary: { optimizedCompletion: 1, baselineCompletion: 0, fullPasses: 1, selectedAttempts: 1 },
    cost: { totalUsd: 1, budgetUsd: 100, podHours: 1 },
    executiveFindings: [], modelCompletion: [], efficiencyRuns: [], outcomes: [], qualification: "none",
    failureModes: [], telemetry: [], experiments: [], strategy: [], migration: [], methodNotes: [], artifacts: [], sources: [],
  });
  assert.match(html, /A &lt;report&gt;/);
  assert.match(html, /<svg/);
  assert.doesNotMatch(html, /<script[^>]+src=/);
});
