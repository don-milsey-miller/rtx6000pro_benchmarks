import { createConnection } from "node:net";
import { resolve } from "node:path";
import { ProductHarness, runChecks } from "../../evaluators/lib.mjs";

const mode = process.env.SYNTHETIC_HANG_MODE;
const app = new ProductHarness({ workspace: resolve("test/fixtures/stubborn-product"), prefix: `synthetic-${mode}` });

await runChecks([
  ["service starts", async () => app.start(), { phase: "setup", timeoutCode: "setup_timeout" }],
  [`${mode} hangs`, async (signal) => {
    if (mode === "request") {
      await app.request("/never", { signal });
      return;
    }
    if (mode === "sse") {
      const response = await app.request("/sse", { signal });
      await response.text();
      return;
    }
    if (mode === "socket") {
      const url = new URL(app.base);
      const socket = createConnection({ host: url.hostname, port: Number(url.port) });
      signal.addEventListener("abort", () => socket.destroy(), { once: true });
      await new Promise(() => {});
      return;
    }
    throw new Error(`unknown synthetic mode: ${mode}`);
  }, { phase: "request", timeoutCode: `${mode}_timeout` }],
], { cleanup: () => app.cleanup(), diagnostics: () => app.diagnostics() });
