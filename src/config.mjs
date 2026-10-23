import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateSuite(suite) {
  assert(suite?.schemaVersion === 1, "suite schemaVersion must be 1");
  assert(suite.platform === "linux", "suite must target Linux");
  assert(Array.isArray(suite.tasks) && suite.tasks.length >= 3, "suite requires at least three tasks");
  const ids = new Set();
  const scales = new Set();
  for (const task of suite.tasks) {
    assert(/^[a-z0-9-]+$/.test(task.id), `invalid task id: ${task.id}`);
    assert(!ids.has(task.id), `duplicate task id: ${task.id}`);
    ids.add(task.id);
    scales.add(task.scale);
    assert(Number.isInteger(task.deadlineSeconds) && task.deadlineSeconds > 0, `${task.id} has invalid deadline`);
    assert(Number.isFinite(task.weight) && task.weight > 0, `${task.id} has invalid weight`);
    assert(task.seedDirectory && task.evaluator, `${task.id} is missing paths`);
  }
  for (const required of ["small", "medium", "large"]) assert(scales.has(required), `suite is missing ${required} task`);
  return suite;
}

export function validateModels(config) {
  assert(config?.schemaVersion === 1, "models schemaVersion must be 1");
  assert(Array.isArray(config.models) && config.models.length > 0, "models list is empty");
  const ids = new Set();
  const gpus = new Set();
  for (const model of config.models) {
    assert(!ids.has(model.id), `duplicate model id: ${model.id}`);
    assert(!gpus.has(model.gpu), `duplicate GPU assignment: ${model.gpu}`);
    ids.add(model.id);
    gpus.add(model.gpu);
    assert(model.provider && model.model && model.endpoint && model.metrics, `${model.id} is incomplete`);
    const endpoint = new URL(model.endpoint);
    const metrics = new URL(model.metrics);
    assert(["127.0.0.1", "localhost"].includes(endpoint.hostname), `${model.id} endpoint must be loopback`);
    assert(["127.0.0.1", "localhost"].includes(metrics.hostname), `${model.id} metrics must be loopback`);
  }
  return config;
}

export function validateExperiment(experiment) {
  assert(experiment?.schemaVersion === 1, "experiment schemaVersion must be 1");
  assert(Number.isFinite(experiment.budgetUsd) && experiment.budgetUsd > 0, "budget must be positive");
  assert(experiment.budgetSafetyFraction >= 0.05 && experiment.budgetSafetyFraction < 0.5, "budget safety fraction is unsafe");
  assert(Number.isInteger(experiment.gpuCount) && experiment.gpuCount > 0, "gpuCount must be positive");
  assert(Number.isInteger(experiment.runsPerCell) && experiment.runsPerCell > 0, "runsPerCell must be positive");
  return experiment;
}

export async function loadConfiguration(root) {
  const [suite, models, experiment] = await Promise.all([
    readJson(resolve(root, "config/suite.json")),
    readJson(resolve(root, "config/models.json")),
    readJson(resolve(root, "config/experiment.json")),
  ]);
  return {
    suite: validateSuite(suite),
    models: validateModels(models),
    experiment: validateExperiment(experiment),
  };
}

export function buildRunPlan({ suite, models, experiment }) {
  const plan = [];
  for (let repetition = 1; repetition <= experiment.runsPerCell; repetition += 1) {
    for (let taskIndex = 0; taskIndex < suite.tasks.length; taskIndex += 1) {
      for (let modelIndex = 0; modelIndex < models.models.length; modelIndex += 1) {
        const task = suite.tasks[taskIndex];
        const model = models.models[(modelIndex + taskIndex + repetition - 1) % models.models.length];
        plan.push({
          runId: `${task.id}-${model.id}-r${repetition}`,
          repetition,
          task,
          model,
        });
      }
    }
  }
  return plan;
}

export function filterRunPlan(plan, { modelIds = [], taskIds = [] } = {}) {
  const models = new Set(modelIds.filter(Boolean));
  const tasks = new Set(taskIds.filter(Boolean));
  const selected = plan.filter((run) =>
    (!models.size || models.has(run.model.id)) &&
    (!tasks.size || tasks.has(run.task.id))
  );
  if (!selected.length) throw new Error("run filters selected no benchmark cells");
  return selected;
}

export function budgetRuntimeSeconds({ budgetUsd, budgetSafetyFraction }, hourlyRateUsd) {
  assert(Number.isFinite(hourlyRateUsd) && hourlyRateUsd > 0, "hourly rate must be positive");
  return Math.floor((budgetUsd * (1 - budgetSafetyFraction) / hourlyRateUsd) * 3600);
}

