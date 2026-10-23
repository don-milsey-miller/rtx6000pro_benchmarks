import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const dataFile = process.env.DATA_FILE ?? "./data/queuepilot.json";
let tenants;
try { tenants = JSON.parse(process.env.TENANTS_JSON ?? "{}"); } catch { throw new Error("TENANTS_JSON must be valid JSON"); }
if (!tenants || Array.isArray(tenants) || typeof tenants !== "object") throw new Error("TENANTS_JSON must map tenant ids to tokens");
const tokenTenants = new Map(Object.entries(tenants).map(([tenant, token]) => [token, tenant]));
let state = { projects: [], issues: [], audit: [], idempotency: [] };
let writes = Promise.resolve();
const clients = new Set();

try {
  const loaded = JSON.parse(await readFile(dataFile, "utf8"));
  if (Array.isArray(loaded.projects) && Array.isArray(loaded.issues) && Array.isArray(loaded.audit)) state = { ...state, ...loaded };
} catch (error) { if (error.code !== "ENOENT") throw error; }

function persist() {
  const snapshot = JSON.stringify(state);
  writes = writes.then(async () => {
    await mkdir(dirname(dataFile), { recursive: true });
    const temporary = `${dataFile}.${process.pid}.tmp`;
    await writeFile(temporary, snapshot);
    await rename(temporary, dataFile);
  });
  return writes;
}
function send(response, status, value = null, headers = {}) {
  if (value === null) return response.writeHead(status, headers).end();
  const encoded = typeof value === "string" ? value : JSON.stringify(value);
  response.writeHead(status, { "content-type": typeof value === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", ...headers }).end(encoded);
}
function fail(response, status, code, message) { send(response, status, { error: { code, message } }); }
function readBody(request, max = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let done = false;
    request.on("data", (chunk) => { size += chunk.length; if (done) return; if (size > max) { done = true; reject(Object.assign(new Error("body too large"), { status: 413 })); } else chunks.push(chunk); });
    request.on("end", () => { if (!done) resolve(Buffer.concat(chunks)); }); request.on("error", reject);
  });
}
async function json(request) { try { return JSON.parse((await readBody(request)).toString("utf8")); } catch (error) { if (error.status) throw error; throw Object.assign(new Error("malformed JSON"), { status: 400 }); } }
function tenantOf(request) { const value = request.headers.authorization; return typeof value === "string" && value.startsWith("Bearer ") ? tokenTenants.get(value.slice(7)) : undefined; }
function requireString(value, name, max, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw Object.assign(new Error(`${name} must be a non-empty string of at most ${max} characters`), { status: 400 });
  return value.trim();
}
function audit(tenant, type, resourceId, details = {}) {
  const event = { id: randomUUID(), tenant, type, resourceId, at: new Date().toISOString(), details };
  state.audit.push(event); publish(tenant, type, { resourceId, ...details }); return event;
}
function publish(tenant, event, data) {
  const encoded = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) if (client.tenant === tenant) client.response.write(encoded);
}
function page(items, search) {
  const limit = search.has("limit") ? Number(search.get("limit")) : 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new Error("limit must be from 1 to 100"), { status: 400 });
  let offset = 0;
  if (search.has("cursor")) { offset = Number(Buffer.from(search.get("cursor"), "base64url").toString()); if (!Number.isInteger(offset) || offset < 0) throw Object.assign(new Error("invalid cursor"), { status: 400 }); }
  return { items: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? Buffer.from(String(offset + limit)).toString("base64url") : null };
}
function project(tenant, id) { return state.projects.find((item) => item.tenant === tenant && item.id === id); }
function issueFor(tenant, id) { return state.issues.find((item) => item.tenant === tenant && item.id === id); }
function publicProject(item) { const { tenant, ...value } = item; return value; }
function publicIssue(item) { const { tenant, ...value } = item; return value; }
function fingerprint(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

const html = `<!doctype html><html><head><meta charset="utf-8"><title>QueuePilot</title><style>body{font:15px system-ui;max-width:1000px;margin:2rem auto;padding:0 1rem}form{border:1px solid #ccc;padding:1rem;margin:1rem 0}input,textarea,select{display:block;width:100%;margin:.4rem 0;padding:.5rem}</style></head><body><h1>QueuePilot</h1><label>Tenant token <input id="token" type="password"></label><form id="projectForm"><h2>Create project</h2><input name="name" required><button>Create</button></form><form id="issueForm"><h2>Create issue</h2><input name="projectId" placeholder="Project id" required><input name="title" required><select name="priority"><option>normal</option><option>high</option><option>urgent</option><option>low</option></select><button>Create</button></form><button id="refresh">Refresh issues</button><pre id="output"></pre><script>
const auth=()=>({authorization:'Bearer '+token.value,'content-type':'application/json'});projectForm.onsubmit=async e=>{e.preventDefault();let d=new FormData(projectForm);output.textContent=JSON.stringify(await fetch('/api/projects',{method:'POST',headers:auth(),body:JSON.stringify({name:d.get('name')})}).then(r=>r.json()),null,2)};issueForm.onsubmit=async e=>{e.preventDefault();let d=new FormData(issueForm);output.textContent=JSON.stringify(await fetch('/api/projects/'+d.get('projectId')+'/issues',{method:'POST',headers:{...auth(),'idempotency-key':crypto.randomUUID()},body:JSON.stringify({title:d.get('title'),priority:d.get('priority')})}).then(r=>r.json()),null,2)};refresh.onclick=async()=>output.textContent=JSON.stringify(await fetch('/api/issues',{headers:auth()}).then(r=>r.json()),null,2);async function events(){const r=await fetch('/api/events',{headers:{authorization:'Bearer '+token.value}});const reader=r.body.getReader();while(true){const x=await reader.read();if(x.done)break;console.log(new TextDecoder().decode(x.value))}};
</script></body></html>`;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") return send(response, 200, { status: "ok" });
    if (request.method === "GET" && url.pathname === "/") return send(response, 200, html, { "content-type": "text/html; charset=utf-8" });
    if (!url.pathname.startsWith("/api/")) return fail(response, 404, "not_found", "route not found");
    const tenant = tenantOf(request);
    if (!tenant) return fail(response, 401, "unauthorized", "valid bearer token required");

    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      response.write(`event: ready\ndata: ${JSON.stringify({ tenant })}\n\n`);
      const client = { tenant, response }; clients.add(client);
      request.on("close", () => clients.delete(client)); return;
    }
    if (url.pathname === "/api/projects" && request.method === "POST") {
      const input = await json(request); const name = requireString(input.name, "name", 120);
      const item = { id: randomUUID(), tenant, name, createdAt: new Date().toISOString() };
      state.projects.push(item); audit(tenant, "project.created", item.id, { name }); await persist(); return send(response, 201, publicProject(item));
    }
    if (url.pathname === "/api/projects" && request.method === "GET") return send(response, 200, state.projects.filter((item) => item.tenant === tenant).map(publicProject));

    const createIssue = url.pathname.match(/^\/api\/projects\/([^/]+)\/issues$/);
    if (createIssue && request.method === "POST") {
      const owner = project(tenant, decodeURIComponent(createIssue[1])); if (!owner) return fail(response, 404, "not_found", "project not found");
      const input = await json(request); const title = requireString(input.title, "title", 200); const description = input.description === undefined ? "" : requireString(input.description, "description", 10_000, true);
      const priority = input.priority ?? "normal"; if (!["low", "normal", "high", "urgent"].includes(priority)) return fail(response, 400, "invalid_priority", "priority is invalid");
      const idempotencyKey = request.headers["idempotency-key"];
      const requestFingerprint = fingerprint({ projectId: owner.id, title, description, priority });
      if (idempotencyKey) {
        const existing = state.idempotency.find((item) => item.tenant === tenant && item.key === idempotencyKey);
        if (existing) {
          if (existing.fingerprint !== requestFingerprint) return fail(response, 409, "idempotency_conflict", "key was used for different input");
          return send(response, 200, publicIssue(issueFor(tenant, existing.issueId)));
        }
      }
      const timestamp = new Date().toISOString();
      const item = { id: randomUUID(), tenant, projectId: owner.id, title, description, priority, status: "open", version: 1, comments: [], createdAt: timestamp, updatedAt: timestamp };
      state.issues.push(item); if (idempotencyKey) state.idempotency.push({ tenant, key: idempotencyKey, fingerprint: requestFingerprint, issueId: item.id });
      audit(tenant, "issue.created", item.id, { projectId: owner.id, title, priority }); await persist(); return send(response, 201, publicIssue(item));
    }
    if (url.pathname === "/api/issues" && request.method === "GET") {
      let items = state.issues.filter((item) => item.tenant === tenant).reverse();
      for (const field of ["projectId", "status", "priority"]) { const value = url.searchParams.get(field); if (value) items = items.filter((item) => item[field] === value); }
      const q = (url.searchParams.get("q") ?? "").toLowerCase(); if (q) items = items.filter((item) => item.title.toLowerCase().includes(q) || item.description.toLowerCase().includes(q));
      const result = page(items, url.searchParams); return send(response, 200, { ...result, items: result.items.map(publicIssue) });
    }
    const issueRoute = url.pathname.match(/^\/api\/issues\/([^/]+)$/);
    if (issueRoute) {
      const item = issueFor(tenant, decodeURIComponent(issueRoute[1])); if (!item) return fail(response, 404, "not_found", "issue not found");
      if (request.method === "GET") return send(response, 200, publicIssue(item));
      if (request.method === "PATCH") {
        const match = String(request.headers["if-match"] ?? "").match(/^"(\d+)"$/);
        if (!match || Number(match[1]) !== item.version) return fail(response, 409, "version_conflict", "current quoted version is required");
        const input = await json(request); const details = {};
        if (input.title !== undefined) { item.title = requireString(input.title, "title", 200); details.title = item.title; }
        if (input.description !== undefined) { item.description = requireString(input.description, "description", 10_000, true); details.description = item.description; }
        if (input.priority !== undefined) { if (!["low", "normal", "high", "urgent"].includes(input.priority)) return fail(response, 400, "invalid_priority", "priority is invalid"); item.priority = input.priority; details.priority = item.priority; }
        if (input.status !== undefined) {
          const transitions = { open: ["in_progress", "closed"], in_progress: ["open", "closed"], closed: ["open"] };
          if (!transitions[item.status].includes(input.status)) return fail(response, 400, "invalid_transition", "status transition is invalid");
          item.status = input.status; details.status = item.status;
        }
        if (!Object.keys(details).length) return fail(response, 400, "empty_update", "no supported fields supplied");
        item.version += 1; item.updatedAt = new Date().toISOString(); audit(tenant, "issue.updated", item.id, details); await persist(); return send(response, 200, publicIssue(item));
      }
    }
    const comments = url.pathname.match(/^\/api\/issues\/([^/]+)\/comments$/);
    if (comments && request.method === "POST") {
      const item = issueFor(tenant, decodeURIComponent(comments[1])); if (!item) return fail(response, 404, "not_found", "issue not found");
      const input = await json(request); const comment = { id: randomUUID(), body: requireString(input.body, "body", 5_000), createdAt: new Date().toISOString() };
      item.comments.push(comment); item.version += 1; item.updatedAt = comment.createdAt; audit(tenant, "comment.created", item.id, { commentId: comment.id }); await persist(); return send(response, 201, comment);
    }
    if (url.pathname === "/api/audit" && request.method === "GET") {
      const items = state.audit.filter((item) => item.tenant === tenant).reverse().map(({ tenant: _tenant, ...item }) => item);
      return send(response, 200, page(items, url.searchParams));
    }
    fail(response, 404, "not_found", "route not found");
  } catch (error) {
    if (error.status === 413) fail(response, 413, "body_too_large", error.message);
    else if (error.status === 400) fail(response, 400, "invalid_request", error.message);
    else { console.error(error); fail(response, 500, "internal_error", "internal error"); }
  }
});

const heartbeat = setInterval(() => { for (const client of clients) client.response.write(": keepalive\n\n"); }, 15_000); heartbeat.unref();
server.listen(port, host);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  clearInterval(heartbeat); for (const client of clients) client.response.end(); clients.clear();
  server.close(() => writes.finally(() => process.exit(0)));
});

