import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { redactText, redactValue } from "../src/redact.mjs";

export { assert };

const checkContext = new AsyncLocalStorage();

class CheckTimeoutError extends Error {
  constructor(name, timeoutMs) {
    super(`check timed out after ${timeoutMs} ms: ${name}`);
    this.name = "CheckTimeoutError";
    this.code = "check_deadline_exceeded";
  }
}

function requiredDuration(name, explicitValue) {
  const value = explicitValue ?? Number(process.env[name]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be an explicit positive integer`);
  return value;
}

function activeResources() {
  return typeof process.getActiveResourcesInfo === "function" ? process.getActiveResourcesInfo() : [];
}

async function withDeadline(name, timeoutMs, operation) {
  const controller = new AbortController();
  let settled = false;
  let timer;
  return new Promise((resolvePromise, reject) => {
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    timer = setTimeout(() => {
      const error = new CheckTimeoutError(name, timeoutMs);
      controller.abort(error);
      settle(reject, error);
    }, timeoutMs);
    let result;
    try {
      result = checkContext.run({ signal: controller.signal, name, timeoutMs }, () => operation(controller.signal));
    } catch (error) {
      settle(reject, error);
      return;
    }
    Promise.resolve(result).then(
      (value) => settle(resolvePromise, value),
      (error) => settle(reject, error),
    );
  });
}

function failureFor(error, metadata = {}) {
  if (error instanceof CheckTimeoutError || error?.name === "TimeoutError" || error?.code === "ABORT_ERR") {
    return { outcome: "timeout", failureCode: metadata.timeoutCode ?? `${metadata.phase ?? "check"}_timeout` };
  }
  if (error?.code === "ERR_ASSERTION" || error?.name === "AssertionError") {
    return { outcome: "assertion_fail", failureCode: "assertion_mismatch" };
  }
  return { outcome: "aborted", failureCode: "check_exception" };
}

function summarizeEvaluation(checks, cleanup, finalized) {
  const passed = checks.filter((check) => check.outcome === "pass").length;
  const failed = checks.filter((check) => check.outcome === "assertion_fail").length;
  const unverified = checks.filter((check) => ["timeout", "unverified", "aborted"].includes(check.outcome)).length;
  let evaluationStatus = "unverified";
  let failureOrigin = "unknown";
  let triageConfidence = "low";
  if (finalized && cleanup.completed && passed === checks.length) {
    evaluationStatus = "pass";
    failureOrigin = null;
    triageConfidence = "high";
  } else if (finalized && cleanup.completed && unverified === 0) {
    evaluationStatus = passed > 0 ? "partial" : "assertion_fail";
    failureOrigin = "generated_product";
    triageConfidence = "medium";
  }
  return { passed, failed, unverified, evaluationStatus, failureOrigin, triageConfidence };
}

async function writeJsonAtomic(path, value) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolvePromise));
  const selected = server.address().port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return selected;
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolvePromise(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

export class ProductHarness {
  constructor({ workspace, prefix, extraEnv = {} }) {
    this.workspace = resolve(workspace);
    this.prefix = prefix;
    this.extraEnv = extraEnv;
    this.directory = null;
    this.dataFile = null;
    this.child = null;
    this.base = null;
    this.stdout = "";
    this.stderr = "";
    this.activeRequests = new Map();
    this.requestSequence = 0;
  }

  async setup() {
    this.directory = await mkdtemp(join(tmpdir(), `${this.prefix}-`));
    this.dataFile = join(this.directory, "data.json");
  }

  async start() {
    if (!this.directory) await this.setup();
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) throw new Error("product is already running");
    const port = await freePort();
    this.stdout = "";
    this.stderr = "";
    this.child = spawn(process.execPath, ["src/server.mjs"], {
      cwd: this.workspace,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        DATA_FILE: this.dataFile,
        ...this.extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => { this.stdout += chunk; });
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (this.child.exitCode !== null || this.child.signalCode !== null) throw new Error(`product exited during startup (${this.child.exitCode ?? this.child.signalCode}): ${this.stderr.slice(-2000)}`);
      try {
        const response = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return;
      } catch {}
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    await this.stop(true);
    throw new Error(`product did not become healthy: ${this.stderr.slice(-2000)}`);
  }

  async stop(force = false) {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    const child = this.child;
    child.kill(force ? "SIGKILL" : "SIGTERM");
    await waitForChildExit(child, 2_000);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForChildExit(child, 2_000);
    }
    if (child.exitCode === null && child.signalCode === null) throw new Error(`product process ${child.pid} survived SIGKILL`);
  }

  async cleanup() {
    try {
      await this.stop(true);
    } finally {
      if (this.directory) await rm(this.directory, { recursive: true, force: true });
    }
  }

  async request(path, options = {}) {
    const id = ++this.requestSequence;
    const context = checkContext.getStore();
    const signals = [AbortSignal.timeout(8_000)];
    if (options.signal) signals.push(options.signal);
    if (context?.signal) signals.push(context.signal);
    this.activeRequests.set(id, { id, method: options.method ?? "GET", path, startedAt: new Date().toISOString() });
    try {
      return await fetch(`${this.base}${path}`, { ...options, signal: AbortSignal.any(signals) });
    } finally {
      this.activeRequests.delete(id);
    }
  }

  async json(path, options = {}) {
    const response = await this.request(path, options);
    let body;
    try { body = await response.json(); } catch { body = null; }
    return { response, body };
  }

  diagnostics() {
    return {
      evaluatorPid: process.pid,
      productPid: this.child?.pid ?? null,
      productRunning: Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null),
      base: this.base,
      activeRequests: [...this.activeRequests.values()],
      activeResources: activeResources(),
      stdoutTail: redactText(this.stdout.slice(-4_000), 4_000),
      stderrTail: redactText(this.stderr.slice(-4_000), 4_000),
    };
  }
}

export function jsonOptions(method, body, headers = {}) {
  return { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) };
}

export async function runChecks(checks, {
  cleanup,
  diagnostics,
  checkDeadlineMs: configuredCheckDeadlineMs,
  cleanupDeadlineMs: configuredCleanupDeadlineMs,
  outerDeadlineMs: configuredOuterDeadlineMs,
} = {}) {
  const started = Date.now();
  const monotonicStarted = performance.now();
  const checkDeadlineMs = requiredDuration("BENCH_CHECK_DEADLINE_MS", configuredCheckDeadlineMs);
  const cleanupDeadlineMs = requiredDuration("BENCH_CLEANUP_DEADLINE_MS", configuredCleanupDeadlineMs);
  const outerDeadlineMs = requiredDuration("BENCH_EVALUATOR_DEADLINE_MS", configuredOuterDeadlineMs);
  if (outerDeadlineMs <= cleanupDeadlineMs) throw new Error("outer evaluator deadline must reserve time for cleanup");
  const checksDeadline = started + outerDeadlineMs - cleanupDeadlineMs;
  const output = process.env.GRADE_RESULT_PATH;
  const eventsPath = process.env.GRADE_EVENTS_PATH;
  let sequence = 0;
  const results = [];
  const cleanupResult = { completed: false, durationMs: null, error: null };
  const emit = async (eventType, payload) => {
    if (!eventsPath) return;
    await mkdir(dirname(eventsPath), { recursive: true });
    const event = {
      schemaVersion: 1,
      runId: process.env.BENCH_RUN_ID ?? null,
      candidateId: process.env.BENCH_CANDIDATE_ID ?? null,
      taskId: process.env.BENCH_TASK_ID ?? null,
      seed: process.env.BENCH_SEED ?? null,
      modelId: process.env.BENCH_MODEL_ID ?? null,
      sequence: ++sequence,
      timeUtc: new Date().toISOString(),
      monotonicMs: Number((performance.now() - monotonicStarted).toFixed(3)),
      eventType,
      payload,
    };
    await appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
  };
  const snapshot = async (finalized = false) => {
    const summary = summarizeEvaluation(results, cleanupResult, finalized);
    const value = {
      schemaVersion: 2,
      runId: process.env.BENCH_RUN_ID ?? null,
      candidateId: process.env.BENCH_CANDIDATE_ID ?? null,
      taskId: process.env.BENCH_TASK_ID ?? null,
      seed: process.env.BENCH_SEED ?? null,
      modelId: process.env.BENCH_MODEL_ID ?? null,
      evaluationStatus: summary.evaluationStatus,
      failureOrigin: summary.failureOrigin,
      triageConfidence: summary.triageConfidence,
      finalized,
      passed: summary.passed,
      total: checks.length,
      checksVerifiedPassed: summary.passed,
      checksVerifiedFailed: summary.failed,
      checksUnverified: summary.unverified + Math.max(0, checks.length - results.length),
      durationMs: Date.now() - started,
      deadlines: { checkMs: checkDeadlineMs, cleanupMs: cleanupDeadlineMs, outerMs: outerDeadlineMs },
      cleanup: cleanupResult,
      checks: results,
    };
    await writeJsonAtomic(output, value);
    return value;
  };

  await emit("evaluation.started", { checksTotal: checks.length, checkDeadlineMs, cleanupDeadlineMs, outerDeadlineMs });
  await snapshot(false);
  try {
    for (const [name, check, metadata = {}] of checks) {
      const remainingMs = checksDeadline - Date.now();
      if (remainingMs <= 0) break;
      const timeoutMs = Math.min(checkDeadlineMs, remainingMs);
      const checkStarted = Date.now();
      await emit("test.check.started", { checkId: name, phase: metadata.phase ?? "check", timeoutMs });
      let entry;
      try {
        await withDeadline(name, timeoutMs, check);
        entry = { name, phase: metadata.phase ?? "check", passed: true, outcome: "pass", durationMs: Date.now() - checkStarted };
      } catch (error) {
        const failure = failureFor(error, metadata);
        let evidence = null;
        try { evidence = redactValue(await diagnostics?.(), 4_000); } catch (diagnosticError) { evidence = { error: redactText(diagnosticError?.stack ?? diagnosticError, 2_000) }; }
        entry = {
          name,
          phase: metadata.phase ?? "check",
          passed: false,
          outcome: failure.outcome,
          failureCode: failure.failureCode,
          durationMs: Date.now() - checkStarted,
          error: redactText(error?.stack ?? error, 4_000),
          evidence,
        };
      }
      results.push(entry);
      await emit("test.check.completed", entry);
      await snapshot(false);
      if (entry.outcome === "timeout") break;
    }
  } finally {
    const cleanupStarted = Date.now();
    try {
      await emit("process.cleanup.started", { timeoutMs: cleanupDeadlineMs });
      await withDeadline("evaluator cleanup", cleanupDeadlineMs, async () => cleanup?.());
      cleanupResult.completed = true;
    } catch (error) {
      cleanupResult.error = redactText(error?.stack ?? error, 4_000);
    }
    cleanupResult.durationMs = Date.now() - cleanupStarted;
    await emit("process.cleanup.completed", cleanupResult);
  }
  const result = await snapshot(true);
  await emit("evaluation.completed", {
    evaluationStatus: result.evaluationStatus,
    failureOrigin: result.failureOrigin,
    checksVerifiedPassed: result.checksVerifiedPassed,
    checksVerifiedFailed: result.checksVerifiedFailed,
    checksUnverified: result.checksUnverified,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.evaluationStatus === "pass" ? 0 : 1;
  return result;
}

export async function readOperations(workspace) {
  return readFile(resolve(workspace, "OPERATIONS.md"), "utf8");
}

