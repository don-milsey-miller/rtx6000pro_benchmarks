import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

async function port() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

let product;
before(async () => {
  const directory = await mkdtemp(join(tmpdir(), "hookbin-public-"));
  const selected = await port();
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(selected), DATA_FILE: join(directory, "data.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${selected}`;
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`${base}/health`)).ok) { product = { directory, child, base }; return; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("HookBin did not start");
});
after(async () => {
  if (!product) return;
  product.child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (product.child.exitCode === null) product.child.kill("SIGKILL");
  await rm(product.directory, { recursive: true, force: true });
});

test("creates an inbox, verifies a delivery, and lists it", async () => {
  const created = await fetch(`${product.base}/api/inboxes`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "builds" }),
  });
  assert.equal(created.status, 201);
  const inbox = await created.json();
  const raw = Buffer.from('{"build":"ok"}');
  const signature = createHmac("sha256", inbox.secret).update(raw).digest("hex");
  const delivered = await fetch(`${product.base}/hooks/${inbox.key}`, {
    method: "POST", headers: { "content-type": "application/json", "x-hook-signature": `sha256=${signature}` }, body: raw,
  });
  assert.equal(delivered.status, 202);
  const list = await fetch(`${product.base}/api/inboxes/${inbox.key}/events`, {
    headers: { authorization: `Bearer ${inbox.secret}` },
  });
  assert.equal(list.status, 200);
  const events = await list.json();
  assert.equal(events.items.length, 1);
  assert.equal(Buffer.from(events.items[0].body, "base64").toString(), raw.toString());
});

test("rejects an invalid signature", async () => {
  const response = await fetch(`${product.base}/hooks/does-not-exist`, {
    method: "POST", headers: { "x-hook-signature": "sha256=00" }, body: "bad",
  });
  assert.ok([401, 404].includes(response.status));
});

test("serves an HTML interface", async () => {
  const response = await fetch(`${product.base}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /hook/i);
});

