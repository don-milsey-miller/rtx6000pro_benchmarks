import { writeFile } from "node:fs/promises";
import { freemem, loadavg, totalmem } from "node:os";
import { runBounded } from "./process.mjs";

export async function fetchText(url, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export class TelemetrySampler {
  constructor({ metricsUrl, intervalMs = 2_000 }) {
    this.metricsUrl = metricsUrl;
    this.intervalMs = intervalMs;
    this.metrics = [];
    this.gpu = [];
    this.host = [];
    this.errors = [];
    this.timer = null;
    this.running = false;
  }

  async sample() {
    if (this.running) return;
    this.running = true;
    const at = new Date().toISOString();
    const memory = process.memoryUsage();
    this.host.push({
      at,
      load1: loadavg()[0],
      load5: loadavg()[1],
      load15: loadavg()[2],
      memoryUsedBytes: totalmem() - freemem(),
      memoryTotalBytes: totalmem(),
      samplerRssBytes: memory.rss,
    });
    try {
      const text = await fetchText(this.metricsUrl);
      this.metrics.push({ at, text });
    } catch (error) {
      this.errors.push({ at, source: "vllm", error: error.message });
    }
    try {
      const result = await runBounded("nvidia-smi", [
        "--query-gpu=index,utilization.gpu,memory.used,memory.total,power.draw,temperature.gpu,clocks.sm",
        "--format=csv,noheader,nounits",
      ], { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 });
      if (result.code === 0) this.gpu.push({ at, csv: result.stdout.trim() });
      else this.errors.push({ at, source: "nvidia-smi", error: result.stderr.trim() || `exit ${result.code}` });
    } catch (error) {
      this.errors.push({ at, source: "nvidia-smi", error: error.message });
    }
    this.running = false;
  }

  async start() {
    await this.sample();
    this.timer = setInterval(() => void this.sample(), this.intervalMs);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 20));
    await this.sample();
  }

  async save(path) {
    await writeFile(path, `${JSON.stringify({ metrics: this.metrics, gpu: this.gpu, host: this.host, errors: this.errors }, null, 2)}\n`, "utf8");
  }
}

export function summarizeHost(samples) {
  const stats = (field) => {
    const values = samples.map((row) => Number(row[field])).filter(Number.isFinite);
    return values.length ? { mean: values.reduce((a, b) => a + b, 0) / values.length, max: Math.max(...values) } : { mean: null, max: null };
  };
  return {
    samples: samples.length,
    load1: stats("load1"),
    load5: stats("load5"),
    memoryUsedBytes: stats("memoryUsedBytes"),
    samplerRssBytes: stats("samplerRssBytes"),
  };
}

export function summarizeGpu(samples, selectedGpu = null) {
  const rows = [];
  for (const sample of samples) {
    for (const line of String(sample.csv ?? "").split(/\r?\n/)) {
      const values = line.split(",").map((value) => Number(value.trim()));
      if (values.length !== 7 || values.some(Number.isNaN)) continue;
      const [gpu, utilization, memoryUsedMiB, memoryTotalMiB, powerW, temperatureC, clockMHz] = values;
      if (selectedGpu !== null && gpu !== selectedGpu) continue;
      rows.push({ gpu, utilization, memoryUsedMiB, memoryTotalMiB, powerW, temperatureC, clockMHz });
    }
  }
  const stats = (field) => {
    const values = rows.map((row) => row[field]);
    return values.length ? { mean: values.reduce((a, b) => a + b, 0) / values.length, max: Math.max(...values) } : { mean: null, max: null };
  };
  return {
    samples: rows.length,
    utilizationPercent: stats("utilization"),
    memoryUsedMiB: stats("memoryUsedMiB"),
    powerW: stats("powerW"),
    temperatureC: stats("temperatureC"),
    clockMHz: stats("clockMHz"),
  };
}

