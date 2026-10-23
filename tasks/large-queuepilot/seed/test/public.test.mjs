import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

const auth = (token) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
let product;
before(async () => {
  const directory = await mkdtemp(join(tmpdir(), "queuepilot-public-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_FILE: join(directory, "data.json"),
      TENANTS_JSON: JSON.stringify({ alpha: "alpha-token", beta: "beta-token" }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`${base}/health`)).ok) { product = { base, child, directory }; return; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("QueuePilot did not start");
});
after(async () => {
  if (!product) return;
  product.child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (product.child.exitCode === null) product.child.kill("SIGKILL");
  await rm(product.directory, { recursive: true, force: true });
});

test("creates a tenant-scoped project and issue", async () => {
  const projectResponse = await fetch(`${product.base}/api/projects`, {
    method: "POST", headers: auth("alpha-token"), body: JSON.stringify({ name: "Platform" }),
  });
  assert.equal(projectResponse.status, 201);
  const project = await projectResponse.json();
  const issueResponse = await fetch(`${product.base}/api/projects/${project.id}/issues`, {
    method: "POST", headers: { ...auth("alpha-token"), "idempotency-key": "first-issue" },
    body: JSON.stringify({ title: "Ship dashboard", priority: "high" }),
  });
  assert.equal(issueResponse.status, 201);
  const issue = await issueResponse.json();
  assert.equal(issue.status, "open");
  assert.equal(issue.version, 1);

  const betaList = await fetch(`${product.base}/api/issues`, { headers: auth("beta-token") });
  assert.equal(betaList.status, 200);
  assert.equal((await betaList.json()).items.length, 0);
});

test("requires authorization", async () => {
  assert.equal((await fetch(`${product.base}/api/projects`)).status, 401);
});

test("serves a dashboard", async () => {
  const response = await fetch(`${product.base}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<form/i);
  assert.match(html, /issue/i);
});

