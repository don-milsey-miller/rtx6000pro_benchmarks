import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { assert, jsonOptions, ProductHarness, readOperations, runChecks } from "./lib.mjs";

const workspace = process.env.BENCH_WORKSPACE;
if (!workspace) throw new Error("BENCH_WORKSPACE is required");
const tenants = { alpha: "alpha-token", beta: "beta-token" };
const app = new ProductHarness({ workspace, prefix: "queuepilot-grade", extraEnv: { TENANTS_JSON: JSON.stringify(tenants) } });
const headers = (token = tenants.alpha) => ({ authorization: `Bearer ${token}` });
const json = (method, body, token = tenants.alpha, extra = {}) => jsonOptions(method, body, { ...headers(token), ...extra });
let project;
let issue;

await runChecks([
  ["service starts and reports health", async () => {
    await app.start();
    assert.deepEqual((await app.json("/health")).body, { status: "ok" });
  }],
  ["rejects absent and invalid bearer tokens", async () => {
    assert.equal((await app.request("/api/projects")).status, 401);
    assert.equal((await app.request("/api/projects", { headers: headers("wrong") })).status, 401);
  }],
  ["creates and lists tenant project", async () => {
    const created = await app.json("/api/projects", json("POST", { name: "Platform" }));
    assert.equal(created.response.status, 201);
    assert.ok(created.body.id && created.body.createdAt);
    project = created.body;
    const listed = await app.json("/api/projects", { headers: headers() });
    assert.ok(listed.body.some((item) => item.id === project.id));
  }],
  ["enforces strict tenant isolation", async () => {
    const betaProjects = await app.json("/api/projects", { headers: headers(tenants.beta) });
    assert.ok(!betaProjects.body.some((item) => item.id === project.id));
    const crossCreate = await app.request(`/api/projects/${project.id}/issues`, json("POST", { title: "Intrusion" }, tenants.beta));
    assert.equal(crossCreate.status, 404);
  }],
  ["creates issue with defaults and idempotency", async () => {
    const request = json("POST", { title: "Ship queue", description: "Release it", priority: "high" }, tenants.alpha, { "idempotency-key": "issue-1" });
    const first = await app.json(`/api/projects/${project.id}/issues`, request);
    const repeat = await app.json(`/api/projects/${project.id}/issues`, request);
    assert.equal(first.response.status, 201);
    assert.ok([200, 201].includes(repeat.response.status));
    assert.equal(first.body.id, repeat.body.id);
    assert.equal(first.body.status, "open");
    assert.equal(first.body.version, 1);
    issue = first.body;
  }],
  ["filters, searches, and paginates issues", async () => {
    for (let index = 0; index < 3; index += 1) {
      await app.json(`/api/projects/${project.id}/issues`, json("POST", { title: `Background ${index}`, priority: "normal" }, tenants.alpha, { "idempotency-key": `extra-${index}` }));
    }
    const page1 = await app.json(`/api/issues?projectId=${project.id}&status=open&priority=normal&q=BACKGROUND&limit=2`, { headers: headers() });
    assert.equal(page1.response.status, 200);
    assert.equal(page1.body.items.length, 2);
    assert.equal(typeof page1.body.nextCursor, "string");
    const page2 = await app.json(`/api/issues?projectId=${project.id}&status=open&priority=normal&q=BACKGROUND&limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`, { headers: headers() });
    assert.equal(page2.body.items.length, 1);
  }],
  ["returns issue with comments and version", async () => {
    const detail = await app.json(`/api/issues/${issue.id}`, { headers: headers() });
    assert.equal(detail.response.status, 200);
    assert.deepEqual(detail.body.comments, []);
    assert.equal(detail.body.version, 1);
  }],
  ["requires a current If-Match version", async () => {
    assert.equal((await app.request(`/api/issues/${issue.id}`, json("PATCH", { status: "in_progress" }))).status, 409);
    assert.equal((await app.request(`/api/issues/${issue.id}`, json("PATCH", { status: "in_progress" }, tenants.alpha, { "if-match": '"0"' }))).status, 409);
  }],
  ["updates with optimistic concurrency and legal transition", async () => {
    const updated = await app.json(`/api/issues/${issue.id}`, json("PATCH", { status: "in_progress", priority: "urgent" }, tenants.alpha, { "if-match": '"1"' }));
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.status, "in_progress");
    assert.equal(updated.body.priority, "urgent");
    assert.equal(updated.body.version, 2);
    issue = updated.body;
  }],
  ["rejects invalid state and malformed fields", async () => {
    const badPriority = await app.request(`/api/issues/${issue.id}`, json("PATCH", { priority: "catastrophic" }, tenants.alpha, { "if-match": '"2"' }));
    assert.equal(badPriority.status, 400);
    const badState = await app.request(`/api/issues/${issue.id}`, json("PATCH", { status: "unknown" }, tenants.alpha, { "if-match": '"2"' }));
    assert.equal(badState.status, 400);
  }],
  ["adds immutable comment and increments version", async () => {
    const comment = await app.json(`/api/issues/${issue.id}/comments`, json("POST", { body: "Ready for review" }));
    assert.equal(comment.response.status, 201);
    const detail = await app.json(`/api/issues/${issue.id}`, { headers: headers() });
    assert.equal(detail.body.comments.length, 1);
    assert.equal(detail.body.comments[0].body, "Ready for review");
    assert.equal(detail.body.version, 3);
    issue = detail.body;
  }],
  ["records tenant audit trail without duplicate idempotent event", async () => {
    const audit = await app.json("/api/audit?limit=100", { headers: headers() });
    assert.equal(audit.response.status, 200);
    const issueCreates = audit.body.items.filter((item) => item.type === "issue.created" && item.resourceId === issue.id);
    assert.equal(issueCreates.length, 1);
    assert.ok(audit.body.items.some((item) => item.type === "issue.updated" && item.resourceId === issue.id));
    assert.ok(audit.body.items.some((item) => item.type === "comment.created" && item.resourceId === issue.id));
    const betaAudit = await app.json("/api/audit", { headers: headers(tenants.beta) });
    assert.equal(betaAudit.body.items.length, 0);
  }],
  ["streams ready and tenant-scoped SSE events", async () => {
    const controller = new AbortController();
    const response = await fetch(`${app.base}/api/events`, { headers: headers(), signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (pattern) => {
      const deadline = Date.now() + 5_000;
      while (!pattern.test(text) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      assert.match(text, pattern);
    };
    await readUntil(/event:\s*ready/);
    await app.json("/api/projects", json("POST", { name: "Realtime" }));
    await readUntil(/project\.created/);
    controller.abort();
    try { await reader.cancel(); } catch {}
  }],
  ["handles concurrent tenant writes", async () => {
    const responses = await Promise.all(Array.from({ length: 10 }, (_, index) => app.json(`/api/projects/${project.id}/issues`, json("POST", { title: `Concurrent ${index}` }, tenants.alpha, { "idempotency-key": `concurrent-${index}` }))));
    assert.ok(responses.every(({ response }) => response.status === 201));
    const list = await app.json(`/api/issues?projectId=${project.id}&q=Concurrent&limit=100`, { headers: headers() });
    assert.equal(list.body.items.length, 10);
  }],
  ["serves dashboard without embedded credentials", async () => {
    const response = await app.request("/");
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /<form/i);
    assert.match(html, /EventSource|text\/event-stream|\/api\/events/i);
    assert.doesNotMatch(html, /alpha-token|beta-token/);
  }],
  ["documents Linux operations and backup", async () => {
    await access(resolve(workspace, "OPERATIONS.md"));
    const operations = await readOperations(workspace);
    assert.match(operations, /DATA_FILE/);
    assert.match(operations, /TENANTS_JSON/);
    assert.match(operations, /backup/i);
    assert.match(operations, /health/i);
  }],
  ["persists tenant state across clean restart", async () => {
    await app.stop();
    await app.start();
    const detail = await app.json(`/api/issues/${issue.id}`, { headers: headers() });
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.comments[0].body, "Ready for review");
    const beta = await app.request(`/api/issues/${issue.id}`, { headers: headers(tenants.beta) });
    assert.equal(beta.status, 404);
  }],
  ["survives malformed input and shuts down cleanly", async () => {
    const malformed = await app.request("/api/projects", { method: "POST", headers: { ...headers(), "content-type": "application/json" }, body: "{" });
    assert.equal(malformed.status, 400);
    assert.equal((await app.request("/health")).status, 200);
    await app.stop();
    assert.ok(app.child.exitCode !== null || app.child.signalCode !== null);
  }],
], { cleanup: () => app.cleanup() });

