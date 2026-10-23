import { spawn } from "node:child_process";

export function runBounded(command, args = [], options = {}) {
  const {
    cwd,
    env = process.env,
    timeoutMs = 60_000,
    maxOutputBytes = 50 * 1024 * 1024,
  } = options;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let truncated = false;
    const collect = (target, chunk, kind) => {
      const size = chunk.length;
      const current = kind === "stdout" ? stdoutBytes : stderrBytes;
      if (current + size <= maxOutputBytes) target.push(chunk);
      else truncated = true;
      if (kind === "stdout") stdoutBytes += size;
      else stderrBytes += size;
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(stderr, chunk, "stderr"));
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 5_000).unref();
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        timedOut,
        truncated,
        wallMs: Date.now() - started,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

