import assert from "node:assert/strict";
import test from "node:test";
import { compareCandidate, scoreAttempt, scoreSuite } from "../src/score.mjs";

const result = (task, model, weight, passed, total, wallSeconds = 60) => ({
  task: { id: task, weight }, model: { id: model }, classification: passed === total ? "passed" : "failed_acceptance", grade: { passed, total }, wallSeconds,
});

test("makes correctness a hard pass gate while preserving partial diagnostics", () => {
  assert.deepEqual(scoreAttempt(result("s", "m", 1, 4, 5)), { completion: 0.8, passed: false, weightedCompletion: 0.8 });
});

test("weights large task completion and reports economics", () => {
  const summary = scoreSuite([result("s", "m", 1, 10, 10), result("l", "m", 8, 5, 10)], 4);
  assert.equal(summary.weightedCompletion, 5 / 9);
  assert.equal(summary.fullPasses, 1);
  assert.equal(summary.weightedWorkPerDollar, 1.25);
});

test("rejects candidate with any cell regression", () => {
  const comparison = compareCandidate([result("s", "m", 1, 10, 10)], [result("s", "m", 1, 9, 10)]);
  assert.equal(comparison.eligible, false);
  assert.equal(comparison.regressions.length, 1);
});

