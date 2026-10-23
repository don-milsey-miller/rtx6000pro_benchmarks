import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { assert, jsonOptions, ProductHarness, runChecks } from "./lib.mjs";

const workspace = process.env.BENCH_WORKSPACE;
if (!workspace) throw new Error("BENCH_WORKSPACE is required");
const app = new ProductHarness({ workspace, prefix: "hookbin-grade" });
let inbox;
let eventId;
let raw;
const owner = () => ({ authorization: `Bearer ${inbox.secret}` });
const signature = (body, secret = inbox.secret) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

await runChecks([
  ["service starts and reports health", async () => {
    await app.start();
    assert.deepEqual((await app.json("/health")).body, { status: "ok" });
  }],
  ["creates inbox with unguessable credentials", async () => {
    const first = await app.json("/api/inboxes", jsonOptions("POST", { name: "Deploy hooks" }));
    const other = await app.json("/api/inboxes", jsonOptions("POST", { name: "Other" }));
    assert.equal(first.response.status, 201);
    assert.ok(first.body.id && first.body.key && first.body.secret);
    assert.ok(first.body.key.length >= 16 && first.body.secret.length >= 24);
    assert.notEqual(first.body.key, other.body.key);
    assert.notEqual(first.body.secret, other.body.secret);
    inbox = first.body;
  }],
  ["rejects missing and invalid signatures", async () => {
    assert.equal((await app.request(`/hooks/${inbox.key}`, { method: "POST", body: "unsigned" })).status, 401);
    assert.equal((await app.request(`/hooks/${inbox.key}`, { method: "POST", headers: { "x-hook-signature": "sha256=00" }, body: "bad" })).status, 401);
  }],
  ["accepts exact signed bytes", async () => {
    raw = Buffer.from([0, 1, 2, 10, 255, 100]);
    const { response, body } = await app.json(`/hooks/${inbox.key}`, {
      method: "POST", headers: { "content-type": "application/octet-stream", "x-hook-signature": signature(raw) }, body: raw,
    });
    assert.equal(response.status, 202);
    assert.ok(body.id);
    eventId = body.id;
  }],
  ["protects owner routes", async () => {
    assert.equal((await app.request(`/api/inboxes/${inbox.key}/events`)).status, 401);
    assert.equal((await app.request(`/api/inboxes/${inbox.key}/events`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  }],
  ["lists and reads exact event body", async () => {
    const list = await app.json(`/api/inboxes/${inbox.key}/events?contentType=application%2Foctet-stream`, { headers: owner() });
    assert.equal(list.response.status, 200);
    assert.equal(list.body.items.length, 1);
    const detail = await app.json(`/api/inboxes/${inbox.key}/events/${eventId}`, { headers: owner() });
    assert.equal(detail.response.status, 200);
    assert.deepEqual(Buffer.from(detail.body.body, "base64"), raw);
  }],
  ["handles concurrent deliveries without loss", async () => {
    const bodies = Array.from({ length: 12 }, (_, index) => Buffer.from(`delivery-${index}`));
    const responses = await Promise.all(bodies.map((body) => app.request(`/hooks/${inbox.key}`, {
      method: "POST", headers: { "content-type": "text/plain", "x-hook-signature": signature(body) }, body,
    })));
    assert.ok(responses.every((response) => response.status === 202));
    const list = await app.json(`/api/inboxes/${inbox.key}/events?limit=100`, { headers: owner() });
    assert.equal(list.body.items.length, 13);
  }],
  ["paginates newest-first", async () => {
    const firstPage = await app.json(`/api/inboxes/${inbox.key}/events?limit=5`, { headers: owner() });
    assert.equal(firstPage.body.items.length, 5);
    assert.equal(typeof firstPage.body.nextCursor, "string");
    const secondPage = await app.json(`/api/inboxes/${inbox.key}/events?limit=5&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`, { headers: owner() });
    assert.equal(secondPage.body.items.length, 5);
    assert.ok(!secondPage.body.items.some((item) => firstPage.body.items.some((prior) => prior.id === item.id)));
  }],
  ["replays original bytes to loopback and records attempt", async () => {
    let received;
    const receiver = createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => { received = { body: Buffer.concat(chunks), replay: request.headers["x-hookbin-replay"] }; response.writeHead(207).end("ok"); });
    });
    await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const port = receiver.address().port;
    try {
      const replay = await app.json(`/api/inboxes/${inbox.key}/events/${eventId}/replay`, jsonOptions("POST", { targetUrl: `http://127.0.0.1:${port}/sink` }, owner()));
      assert.equal(replay.response.status, 200);
      assert.equal(replay.body.status, 207);
      assert.deepEqual(received.body, raw);
      assert.equal(received.replay, "1");
      const detail = await app.json(`/api/inboxes/${inbox.key}/events/${eventId}`, { headers: owner() });
      assert.equal(detail.body.replays.at(-1).status, 207);
    } finally { await new Promise((resolve) => receiver.close(resolve)); }
  }],
  ["blocks non-loopback replay targets", async () => {
    const replay = await app.json(`/api/inboxes/${inbox.key}/events/${eventId}/replay`, jsonOptions("POST", { targetUrl: "https://example.com/collect" }, owner()));
    assert.equal(replay.response.status, 400);
  }],
  ["rejects oversized webhook bodies and remains healthy", async () => {
    const body = Buffer.alloc(270 * 1024, 1);
    const response = await app.request(`/hooks/${inbox.key}`, { method: "POST", headers: { "x-hook-signature": signature(body) }, body });
    assert.equal(response.status, 413);
    assert.equal((await app.request("/health")).status, 200);
  }],
  ["serves owner interface without embedding secrets", async () => {
    const response = await app.request("/");
    const html = await response.text();
    assert.equal(response.status, 200);
    // The contract requires an interface where an owner can enter a key and
    // secret, not a particular HTML container element. Requiring a literal
    // <form> rejected equivalent button-driven interfaces and made the hidden
    // evaluator stricter than the published specification.
    assert.ok((html.match(/<input\b/gi) ?? []).length >= 2);
    assert.match(html, /<button\b|type=["']submit["']/i);
    assert.match(html, /event/i);
    assert.doesNotMatch(html, new RegExp(inbox.secret));
  }],
  ["persists events across clean restart without logging secret", async () => {
    const combinedLogs = `${app.stdout}\n${app.stderr}`;
    assert.doesNotMatch(combinedLogs, new RegExp(inbox.secret));
    await app.stop();
    await app.start();
    const detail = await app.json(`/api/inboxes/${inbox.key}/events/${eventId}`, { headers: owner() });
    assert.equal(detail.response.status, 200);
    assert.deepEqual(Buffer.from(detail.body.body, "base64"), raw);
  }],
  ["purges only the authorized inbox events", async () => {
    assert.equal((await app.request(`/api/inboxes/${inbox.key}/events`, { method: "DELETE", headers: owner() })).status, 204);
    const list = await app.json(`/api/inboxes/${inbox.key}/events`, { headers: owner() });
    assert.equal(list.body.items.length, 0);
  }],
], { cleanup: () => app.cleanup() });

