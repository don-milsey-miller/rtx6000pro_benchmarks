import assert from "node:assert/strict";
import test from "node:test";
import { budgetRuntimeSeconds, buildRunPlan, filterRunPlan, validateExperiment, validateModels, validateSuite } from "../src/config.mjs";

const suite = validateSuite({
  schemaVersion: 1, platform: "linux", tasks: [
    { id: "small-one", scale: "small", weight: 1, deadlineSeconds: 1, seedDirectory: "s", evaluator: "e" },
    { id: "medium-one", scale: "medium", weight: 3, deadlineSeconds: 2, seedDirectory: "s", evaluator: "e" },
    { id: "large-one", scale: "large", weight: 8, deadlineSeconds: 3, seedDirectory: "s", evaluator: "e" },
  ],
});
const models = validateModels({ schemaVersion: 1, models: [
  { id: "a", gpu: 0, provider: "p", model: "m", endpoint: "http://127.0.0.1:1/v1", metrics: "http://127.0.0.1:1/metrics" },
  { id: "b", gpu: 1, provider: "p", model: "m", endpoint: "http://localhost:2/v1", metrics: "http://localhost:2/metrics" },
] });
const experiment = validateExperiment({ schemaVersion: 1, budgetUsd: 100, budgetSafetyFraction: 0.1, gpuCount: 2, runsPerCell: 2 });

test("builds complete rotated run plan", () => {
  const plan = buildRunPlan({ suite, models, experiment });
  assert.equal(plan.length, 12);
  assert.equal(new Set(plan.map((run) => run.runId)).size, 12);
  assert.notEqual(plan[0].model.id, plan[2].model.id);
});

test("calculates budget-safe runtime", () => {
  assert.equal(budgetRuntimeSeconds(experiment, 10), 32_400);
});

test("filters targeted research cells without changing run identity", () => {
  const selected = filterRunPlan(buildRunPlan({ suite, models, experiment }), {
    modelIds: ["a"],
    taskIds: ["small-one"],
  });
  assert.equal(selected.length, 2);
  assert.ok(selected.every((run) => run.model.id === "a" && run.task.id === "small-one"));
  assert.throws(() => filterRunPlan(buildRunPlan({ suite, models, experiment }), { modelIds: ["missing"] }), /no benchmark cells/);
});

test("rejects non-loopback endpoints", () => {
  assert.throws(() => validateModels({ schemaVersion: 1, models: [{ id: "x", gpu: 0, provider: "p", model: "m", endpoint: "https://remote.test/v1", metrics: "http://127.0.0.1/metrics" }] }), /loopback/);
});

