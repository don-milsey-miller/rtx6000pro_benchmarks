import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const dataFile = process.env.DATA_FILE ?? "./data/hookbin.json";
let state = { inboxes: [], events: [] };
let writes = Promise.resolve();
try {
  const loaded = JSON.parse(await readFile(dataFile, "utf8"));
  if (Array.isArray(loaded.inboxes) && Array.isArray(loaded.events)) state = loaded;
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
function send(response, status, body = null, headers = {}) {
  if (body === null) return response.writeHead(status, headers).end();
  const encoded = typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", ...headers }).end(encoded);
}
function fail(response, status, code, message) { send(response, status, { error: { code, message } }); }
function body(request, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let done = false;
    request.on("data", (chunk) => { size += chunk.length; if (done) return; if (size > max) { done = true; reject(Object.assign(new Error("body too large"), { status: 413 })); } else chunks.push(chunk); });
    request.on("end", () => { if (!done) resolve(Buffer.concat(chunks)); }); request.on("error", reject);
  });
}
async function json(request) { try { return JSON.parse((await body(request, 256 * 1024)).toString()); } catch (error) { if (error.status) throw error; throw Object.assign(new Error("malformed JSON"), { status: 400 }); } }
function inboxFor(key) { return state.inboxes.find((inbox) => inbox.key === key); }
function authorize(request, inbox) { return inbox && request.headers.authorization === `Bearer ${inbox.secret}`; }
function signatureValid(raw, header, secret) {
  if (!/^sha256=[0-9a-f]{64}$/.test(header ?? "")) return false;
  const actual = Buffer.from(header.slice(7), "hex");
  const expected = createHmac("sha256", secret).update(raw).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function safeHeaders(headers) { return Object.fromEntries(Object.entries(headers).filter(([name]) => !["authorization", "x-hook-signature", "cookie"].includes(name.toLowerCase())).map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : String(value)])); }
function publicEvent(event) { return { ...event, body: event.bodyBase64, bodyBase64: undefined }; }
function page(items, search) {
  const limit = search.has("limit") ? Number(search.get("limit")) : 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new Error("invalid limit"), { status: 400 });
  let offset = 0;
  if (search.has("cursor")) { offset = Number(Buffer.from(search.get("cursor"), "base64url").toString()); if (!Number.isInteger(offset) || offset < 0) throw Object.assign(new Error("invalid cursor"), { status: 400 }); }
  return { items: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? Buffer.from(String(offset + limit)).toString("base64url") : null };
}
const html = `<!doctype html><html><head><meta charset="utf-8"><title>HookBin</title></head><body><h1>HookBin webhook inbox</h1><form id="create"><input name="name" placeholder="Inbox name"><button>Create inbox</button></form><form id="open"><input name="key" placeholder="Inbox key"><input name="secret" type="password" placeholder="Secret"><button>List events</button></form><pre id="events"></pre><script>create.onsubmit=async e=>{e.preventDefault();let d=new FormData(create);events.textContent=JSON.stringify(await fetch('/api/inboxes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:d.get('name')})}).then(r=>r.json()),null,2)};open.onsubmit=async e=>{e.preventDefault();let d=new FormData(open);events.textContent=JSON.stringify(await fetch('/api/inboxes/'+d.get('key')+'/events',{headers:{authorization:'Bearer '+d.get('secret')}}).then(r=>r.json()),null,2)}</script></body></html>`;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") return send(response, 200, { status: "ok" });
    if (request.method === "GET" && url.pathname === "/") return send(response, 200, html, { "content-type": "text/html; charset=utf-8" });
    if (request.method === "POST" && url.pathname === "/api/inboxes") {
      const input = await json(request);
      if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 100) return fail(response, 400, "invalid_name", "name is required");
      const inbox = { id: randomUUID(), key: randomBytes(16).toString("hex"), secret: randomBytes(32).toString("base64url"), name: input.name.trim(), createdAt: new Date().toISOString() };
      state.inboxes.push(inbox); await persist(); return send(response, 201, inbox);
    }
    const hook = url.pathname.match(/^\/hooks\/([^/]+)$/);
    if (hook && request.method === "POST") {
      const inbox = inboxFor(decodeURIComponent(hook[1]));
      if (!inbox) return fail(response, 404, "not_found", "inbox not found");
      const raw = await body(request, 256 * 1024);
      if (!signatureValid(raw, request.headers["x-hook-signature"], inbox.secret)) return fail(response, 401, "invalid_signature", "signature is invalid");
      const event = { id: randomUUID(), inboxId: inbox.id, method: request.method, contentType: request.headers["content-type"] ?? "application/octet-stream", headers: safeHeaders(request.headers), bodyBase64: raw.toString("base64"), receivedAt: new Date().toISOString(), replays: [] };
      state.events.push(event); await persist(); return send(response, 202, { id: event.id });
    }
    const list = url.pathname.match(/^\/api\/inboxes\/([^/]+)\/events$/);
    if (list) {
      const inbox = inboxFor(decodeURIComponent(list[1]));
      if (!inbox) return fail(response, 404, "not_found", "inbox not found");
      if (!authorize(request, inbox)) return fail(response, 401, "unauthorized", "valid bearer token required");
      if (request.method === "DELETE") { state.events = state.events.filter((event) => event.inboxId !== inbox.id); await persist(); return send(response, 204); }
      if (request.method === "GET") {
        let events = state.events.filter((event) => event.inboxId === inbox.id).reverse();
        const type = url.searchParams.get("contentType"); if (type) events = events.filter((event) => event.contentType === type);
        const result = page(events, url.searchParams); return send(response, 200, { ...result, items: result.items.map(publicEvent) });
      }
    }
    const detail = url.pathname.match(/^\/api\/inboxes\/([^/]+)\/events\/([^/]+)$/);
    if (detail && request.method === "GET") {
      const inbox = inboxFor(decodeURIComponent(detail[1]));
      if (!inbox) return fail(response, 404, "not_found", "inbox not found");
      if (!authorize(request, inbox)) return fail(response, 401, "unauthorized", "valid bearer token required");
      const event = state.events.find((item) => item.inboxId === inbox.id && item.id === decodeURIComponent(detail[2]));
      return event ? send(response, 200, publicEvent(event)) : fail(response, 404, "not_found", "event not found");
    }
    const replay = url.pathname.match(/^\/api\/inboxes\/([^/]+)\/events\/([^/]+)\/replay$/);
    if (replay && request.method === "POST") {
      const inbox = inboxFor(decodeURIComponent(replay[1]));
      if (!inbox) return fail(response, 404, "not_found", "inbox not found");
      if (!authorize(request, inbox)) return fail(response, 401, "unauthorized", "valid bearer token required");
      const event = state.events.find((item) => item.inboxId === inbox.id && item.id === decodeURIComponent(replay[2]));
      if (!event) return fail(response, 404, "not_found", "event not found");
      const input = await json(request); let target;
      try { target = new URL(input.targetUrl); } catch { return fail(response, 400, "invalid_target", "targetUrl is invalid"); }
      if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(target.hostname)) return fail(response, 400, "invalid_target", "only loopback HTTP replay is allowed");
      let downstream;
      try { downstream = await fetch(target, { method: event.method, headers: { "content-type": event.contentType, "x-hookbin-replay": "1" }, body: Buffer.from(event.bodyBase64, "base64"), signal: AbortSignal.timeout(5_000) }); }
      catch { return fail(response, 502, "replay_failed", "downstream request failed"); }
      const attempt = { targetUrl: target.href, status: downstream.status, attemptedAt: new Date().toISOString() };
      event.replays.push(attempt); await persist(); return send(response, 200, attempt);
    }
    fail(response, 404, "not_found", "route not found");
  } catch (error) {
    if (error.status === 413) fail(response, 413, "body_too_large", error.message);
    else if (error.status === 400) fail(response, 400, "invalid_request", error.message);
    else { console.error(error); fail(response, 500, "internal_error", "internal error"); }
  }
});
server.listen(port, host);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => writes.finally(() => process.exit(0))));

