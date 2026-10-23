import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ProductHarness } from "../evaluators/lib.mjs";
import { runBounded } from "../src/process.mjs";

test("hung checks produce partial evidence, redact secrets, clean up, and stop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forgebench-evaluator-test-"));
  const gradePath = resolve(directory, "grade.json");
  const eventsPath = resolve(directory, "events.jsonl");
  try {
    const result = await runBounded(process.execPath, [resolve("test/fixtures/hanging-evaluator.mjs")], {
      env: {
        ...process.env,
        BENCH_RUN_ID: "synthetic-hang",
        BENCH_CANDIDATE_ID: "synthetic",
        BENCH_TASK_ID: "synthetic",
        BENCH_SEED: "6000",
        BENCH_MODEL_ID: "synthetic-model",
        BENCH_CHECK_DEADLINE_MS: "75",
        BENCH_CLEANUP_DEADLINE_MS: "75",
        BENCH_EVALUATOR_DEADLINE_MS: "500",
        GRADE_RESULT_PATH: gradePath,
        GRADE_EVENTS_PATH: eventsPath,
      },
      timeoutMs: 2_000,
      captureTimeoutDiagnostics: true,
    });
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 1);
    const gradeText = await readFile(gradePath, "utf8");
    const grade = JSON.parse(gradeText);
    assert.equal(grade.finalized, true);
    assert.equal(grade.evaluationStatus, "unverified");
    assert.equal(grade.failureOrigin, "unknown");
    assert.equal(grade.passed, 1);
    assert.equal(grade.total, 3);
    assert.equal(grade.checksVerifiedPassed, 1);
    assert.equal(grade.checksUnverified, 2);
    assert.equal(grade.checks[1].outcome, "timeout");
    assert.equal(grade.cleanup.completed, true);
    assert.doesNotMatch(gradeText, /synthetic-secret/);
    const events = (await readFile(eventsPath, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
    assert.ok(events.some((event) => event.eventType === "test.check.completed" && event.payload.outcome === "timeout"));
    assert.equal(events.at(-1).eventType, "evaluation.completed");
    assert.equal(events.at(-1).candidateId, "synthetic");
    assert.equal(events.at(-1).seed, "6000");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ProductHarness force-cleans a service that ignores graceful termination", async () => {
  const app = new ProductHarness({ workspace: resolve("test/fixtures/stubborn-product"), prefix: "stubborn-product" });
  try {
    await app.start();
    assert.equal((await app.request("/health")).status, 200);
    await app.stop(false);
    assert.ok(app.child.exitCode !== null || app.child.signalCode !== null);
  } finally {
    await app.cleanup();
  }
});

test("outer process deadlines capture diagnostics and terminate the target", async () => {
  const result = await runBounded(process.execPath, ["--input-type=module", "-e", "setInterval(() => {}, 1000)"], {
    timeoutMs: 75,
    captureTimeoutDiagnostics: true,
  });
  assert.equal(result.timedOut, true);
  assert.ok(result.signal || result.code !== 0);
  assert.equal(result.timeoutDiagnostics.rootPid, result.pid);
  assert.ok(Array.isArray(result.timeoutDiagnostics.processTree));
});

for (const mode of ["request", "sse", "socket"]) {
  test(`classifies and cleans up a synthetic ${mode} hang`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `forgebench-${mode}-test-`));
    const gradePath = resolve(directory, "grade.json");
    try {
      const result = await runBounded(process.execPath, [resolve("test/fixtures/hanging-product-evaluator.mjs")], {
        env: {
          ...process.env,
          SYNTHETIC_HANG_MODE: mode,
          BENCH_CHECK_DEADLINE_MS: "500",
          BENCH_CLEANUP_DEADLINE_MS: "500",
          BENCH_EVALUATOR_DEADLINE_MS: "2000",
          GRADE_RESULT_PATH: gradePath,
          GRADE_EVENTS_PATH: resolve(directory, "events.jsonl"),
        },
        timeoutMs: 4_000,
      });
      assert.equal(result.timedOut, false);
      const grade = JSON.parse(await readFile(gradePath, "utf8"));
      assert.equal(grade.evaluationStatus, "unverified");
      assert.equal(grade.checks[1].outcome, "timeout");
      assert.equal(grade.checks[1].failureCode, `${mode}_timeout`);
      assert.equal(grade.cleanup.completed, true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
