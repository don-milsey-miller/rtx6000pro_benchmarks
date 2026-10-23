import { access, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfiguration } from "../src/config.mjs";
import { runBounded } from "../src/process.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmPrefix = process.platform === "win32" ? [resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")] : [];
const { suite, models, experiment } = await loadConfiguration(root);
if (models.models.length !== experiment.gpuCount) throw new Error("model count must equal configured GPU count");
const temp = await mkdtemp(join(tmpdir(), "forgebench-validation-"));
const summary = [];
try {
  for (const task of suite.tasks) {
    const reference = resolve(temp, `${task.id}-reference`);
    await cp(resolve(root, task.seedDirectory), reference, { recursive: true });
    await cp(resolve(root, "validation/reference", task.id), reference, { recursive: true, force: true });
    await access(resolve(reference, "src/server.mjs"));
    const publicResult = await runBounded(npmCommand, [...npmPrefix, "test"], { cwd: reference, timeoutMs: 60_000, maxOutputBytes: 10 * 1024 * 1024 });
    if (publicResult.code !== 0) throw new Error(`${task.id} reference failed public tests:\n${publicResult.stdout}\n${publicResult.stderr}`);
    const gradePath = resolve(temp, `${task.id}-grade.json`);
    const gradeEventsPath = resolve(temp, `${task.id}-events.jsonl`);
    const evaluationEnv = {
      BENCH_TASK_ID: task.id,
      BENCH_RUN_ID: `validation-${task.id}`,
      BENCH_CANDIDATE_ID: "validation-reference",
      BENCH_SEED: String(suite.seed),
      BENCH_MODEL_ID: "reference",
      BENCH_CHECK_DEADLINE_MS: String(task.evaluation.checkDeadlineSeconds * 1000),
      BENCH_CLEANUP_DEADLINE_MS: String(task.evaluation.cleanupDeadlineSeconds * 1000),
      BENCH_EVALUATOR_DEADLINE_MS: String(task.evaluation.outerDeadlineSeconds * 1000),
    };
    const gradeResult = await runBounded(process.execPath, [resolve(root, task.evaluator)], {
      cwd: root,
      env: { ...process.env, ...evaluationEnv, BENCH_WORKSPACE: reference, GRADE_RESULT_PATH: gradePath, GRADE_EVENTS_PATH: gradeEventsPath },
      timeoutMs: task.evaluation.outerDeadlineSeconds * 1000 + 5_000,
      maxOutputBytes: 20 * 1024 * 1024,
      captureTimeoutDiagnostics: true,
    });
    const grade = JSON.parse(await readFile(gradePath, "utf8"));
    if (gradeResult.code !== 0 || grade.passed !== grade.total) throw new Error(`${task.id} reference failed independent evaluator: ${JSON.stringify(grade, null, 2)}`);

    const empty = resolve(temp, `${task.id}-empty`);
    await cp(resolve(root, task.seedDirectory), empty, { recursive: true });
    const emptyGrade = resolve(temp, `${task.id}-empty-grade.json`);
    const negative = await runBounded(process.execPath, [resolve(root, task.evaluator)], {
      cwd: root,
      env: { ...process.env, ...evaluationEnv, BENCH_RUN_ID: `validation-empty-${task.id}`, BENCH_CANDIDATE_ID: "validation-empty", BENCH_MODEL_ID: "empty", BENCH_WORKSPACE: empty, GRADE_RESULT_PATH: emptyGrade, GRADE_EVENTS_PATH: resolve(temp, `${task.id}-empty-events.jsonl`) },
      timeoutMs: task.evaluation.outerDeadlineSeconds * 1000 + 5_000,
      maxOutputBytes: 10 * 1024 * 1024,
      captureTimeoutDiagnostics: true,
    });
    const failedGrade = JSON.parse(await readFile(emptyGrade, "utf8"));
    if (negative.code === 0 || failedGrade.passed === failedGrade.total) throw new Error(`${task.id} empty implementation unexpectedly passed`);
    summary.push({ task: task.id, reference: `${grade.passed}/${grade.total}`, empty: `${failedGrade.passed}/${failedGrade.total}` });
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
console.table(summary);
console.log("suite validation passed");

