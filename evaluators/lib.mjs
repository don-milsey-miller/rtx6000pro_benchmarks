import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export { assert };

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolvePromise));
  const selected = server.address().port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return selected;
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
    const exited = new Promise((resolvePromise) => {
      if (child.exitCode !== null || child.signalCode !== null) resolvePromise();
      else child.once("exit", resolvePromise);
    });
    child.kill(force ? "SIGKILL" : "SIGTERM");
    await Promise.race([
      exited,
      new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      const killed = new Promise((resolvePromise) => child.once("exit", resolvePromise));
      child.kill("SIGKILL");
      await Promise.race([killed, new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))]);
    }
  }

  async cleanup() {
    await this.stop(true);
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }

  request(path, options = {}) {
    return fetch(`${this.base}${path}`, { ...options, signal: options.signal ?? AbortSignal.timeout(8_000) });
  }

  async json(path, options = {}) {
    const response = await this.request(path, options);
    let body;
    try { body = await response.json(); } catch { body = null; }
    return { response, body };
  }
}

export function jsonOptions(method, body, headers = {}) {
  return { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) };
}

export async function runChecks(checks, { cleanup } = {}) {
  const started = Date.now();
  const results = [];
  for (const [name, check] of checks) {
    const checkStarted = Date.now();
    try {
      await check();
      results.push({ name, passed: true, durationMs: Date.now() - checkStarted });
    } catch (error) {
      results.push({ name, passed: false, durationMs: Date.now() - checkStarted, error: String(error?.stack ?? error).slice(0, 4_000) });
    }
  }
  try { await cleanup?.(); } catch (error) { results.push({ name: "evaluator cleanup", passed: false, durationMs: 0, error: String(error) }); }
  const result = {
    schemaVersion: 1,
    passed: results.filter((check) => check.passed).length,
    total: results.length,
    durationMs: Date.now() - started,
    checks: results,
  };
  const output = process.env.GRADE_RESULT_PATH;
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.passed === result.total ? 0 : 1;
  return result;
}

export async function readOperations(workspace) {
  return readFile(resolve(workspace, "OPERATIONS.md"), "utf8");
}

