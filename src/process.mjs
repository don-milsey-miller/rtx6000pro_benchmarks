import { spawn } from "node:child_process";
import { redactText } from "./redact.mjs";

function captureCommand(command, args, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    let output = "";
    let error = "";
    let settled = false;
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (spawnError) {
      resolve({ code: null, stdout: "", stderr: String(spawnError) });
      return;
    }
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { error += chunk.toString("utf8"); });
    child.once("error", (spawnError) => finish({ code: null, stdout: output, stderr: String(spawnError) }));
    child.once("close", (code) => finish({ code, stdout: output, stderr: error }));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout: output, stderr: `${error}\ndiagnostic command timed out` });
    }, timeoutMs);
  });
}

function selectProcessTree(text, rootPid) {
  const rows = text.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    return match ? {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      state: match[4],
      elapsedSeconds: Number(match[5]),
      command: redactText(match[6], 2_000),
    } : null;
  }).filter(Boolean);
  const selected = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (selected.has(row.ppid) && !selected.has(row.pid)) {
        selected.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => selected.has(row.pid));
}

export async function captureProcessDiagnostics(rootPid) {
  const capturedAt = new Date().toISOString();
  if (!Number.isInteger(rootPid) || rootPid <= 0) return { capturedAt, rootPid, processTree: [], listeningSockets: [] };
  if (process.platform === "win32") {
    return { capturedAt, rootPid, processTree: [{ pid: rootPid, diagnostic: "process-tree capture is Linux-only" }], listeningSockets: [] };
  }
  const processes = await captureCommand("ps", ["-eo", "pid=,ppid=,pgid=,stat=,etimes=,args="]);
  const processTree = selectProcessTree(processes.stdout, rootPid);
  const pids = new Set(processTree.map((row) => row.pid));
  const sockets = await captureCommand("ss", ["-lntp"]);
  const listeningSockets = sockets.stdout.split(/\r?\n/)
    .filter((line) => [...pids].some((pid) => line.includes(`pid=${pid},`)))
    .map((line) => redactText(line, 2_000));
  return {
    capturedAt,
    rootPid,
    processTree,
    listeningSockets,
    errors: [processes.stderr, sockets.stderr].filter(Boolean).map((value) => redactText(value, 2_000)),
  };
}

function signalProcessTree(child, signal, isolated) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (isolated && process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export function runBounded(command, args = [], options = {}) {
  const {
    cwd,
    env = process.env,
    timeoutMs = 60_000,
    maxOutputBytes = 50 * 1024 * 1024,
    captureTimeoutDiagnostics = false,
    isolateProcessGroup = process.platform !== "win32",
  } = options;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: isolateProcessGroup,
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let truncated = false;
    let timeoutDiagnostics = null;
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
    const timer = setTimeout(async () => {
      timedOut = true;
      if (captureTimeoutDiagnostics) timeoutDiagnostics = await captureProcessDiagnostics(child.pid);
      signalProcessTree(child, "SIGTERM", isolateProcessGroup);
      setTimeout(() => signalProcessTree(child, "SIGKILL", isolateProcessGroup), 5_000).unref();
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        timedOut,
        pid: child.pid,
        truncated,
        timeoutDiagnostics,
        wallMs: Date.now() - started,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

