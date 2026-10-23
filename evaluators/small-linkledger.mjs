import { assert, jsonOptions, ProductHarness, runChecks } from "./lib.mjs";

const workspace = process.env.BENCH_WORKSPACE;
if (!workspace) throw new Error("BENCH_WORKSPACE is required");
const app = new ProductHarness({ workspace, prefix: "linkledger-grade" });
let first;
let second;

await runChecks([
  ["service starts and reports health", async () => {
    await app.start();
    const { response, body } = await app.json("/health");
    assert.equal(response.status, 200);
    assert.deepEqual(body, { status: "ok" });
  }],
  ["creates normalized bookmark", async () => {
    const { response, body } = await app.json("/api/bookmarks", jsonOptions("POST", {
      url: "https://example.com/a", title: "  Alpha docs  ", tags: ["docs", "api", "docs"],
    }));
    assert.equal(response.status, 201);
    assert.ok(body.id);
    assert.equal(body.title, "Alpha docs");
    assert.deepEqual(body.tags, ["docs", "api"]);
    assert.ok(!Number.isNaN(Date.parse(body.createdAt)));
    first = body;
  }],
  ["gets a bookmark by id", async () => {
    const { response, body } = await app.json(`/api/bookmarks/${first.id}`);
    assert.equal(response.status, 200);
    assert.equal(body.url, first.url);
  }],
  ["rejects invalid fields with structured error", async () => {
    const { response, body } = await app.json("/api/bookmarks", jsonOptions("POST", { url: "file:///tmp/x", title: "" }));
    assert.equal(response.status, 400);
    assert.equal(typeof body?.error?.code, "string");
    assert.equal(typeof body?.error?.message, "string");
  }],
  ["searches and filters case-insensitively", async () => {
    ({ body: second } = await app.json("/api/bookmarks", jsonOptions("POST", { url: "https://nodejs.org/api", title: "Node Reference", tags: ["runtime"] })));
    const { response, body } = await app.json("/api/bookmarks?q=NODE&tag=runtime");
    assert.equal(response.status, 200);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].id, second.id);
  }],
  ["paginates with an opaque cursor", async () => {
    const page1 = await app.json("/api/bookmarks?limit=1");
    assert.equal(page1.response.status, 200);
    assert.equal(page1.body.items.length, 1);
    assert.equal(typeof page1.body.nextCursor, "string");
    const page2 = await app.json(`/api/bookmarks?limit=1&cursor=${encodeURIComponent(page1.body.nextCursor)}`);
    assert.equal(page2.response.status, 200);
    assert.equal(page2.body.items.length, 1);
    assert.notEqual(page1.body.items[0].id, page2.body.items[0].id);
  }],
  ["rejects malformed JSON without crashing", async () => {
    const response = await app.request("/api/bookmarks", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    assert.equal(response.status, 400);
    assert.equal((await app.request("/health")).status, 200);
  }],
  ["rejects oversized request body", async () => {
    const response = await app.request("/api/bookmarks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com", title: "x".repeat(70_000) }) });
    assert.equal(response.status, 413);
  }],
  ["serves a functional dependency-free UI", async () => {
    const response = await app.request("/");
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(html, /<form/i);
    assert.match(html, /fetch\s*\(/i);
    assert.match(html, /\/api\/bookmarks/);
  }],
  ["deletes an existing record and reports missing", async () => {
    assert.equal((await app.request(`/api/bookmarks/${first.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await app.request(`/api/bookmarks/${first.id}`)).status, 404);
    assert.equal((await app.request("/missing-route")).status, 404);
  }],
  ["persists committed records across clean restart", async () => {
    await app.stop();
    await app.start();
    const { response, body } = await app.json(`/api/bookmarks/${second.id}`);
    assert.equal(response.status, 200);
    assert.equal(body.title, second.title);
  }],
  ["shuts down on SIGTERM", async () => {
    await app.stop();
    assert.ok(app.child.exitCode !== null || app.child.signalCode !== null);
  }],
], { cleanup: () => app.cleanup() });

