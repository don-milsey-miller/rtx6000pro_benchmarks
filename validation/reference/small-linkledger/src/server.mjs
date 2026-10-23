import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const dataFile = process.env.DATA_FILE ?? "./data/linkledger.json";
let state = { bookmarks: [] };
let writes = Promise.resolve();

try {
  const loaded = JSON.parse(await readFile(dataFile, "utf8"));
  if (Array.isArray(loaded.bookmarks)) state = loaded;
} catch (error) { if (error.code !== "ENOENT") throw error; }

function persist() {
  const snapshot = JSON.stringify(state);
  writes = writes.then(async () => {
    await mkdir(dirname(dataFile), { recursive: true });
    const temporary = `${dataFile}.${process.pid}.tmp`;
    await writeFile(temporary, snapshot, "utf8");
    await rename(temporary, dataFile);
  });
  return writes;
}

function send(response, status, body = null, headers = {}) {
  if (body === null) { response.writeHead(status, headers).end(); return; }
  const encoded = typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", ...headers, "content-length": Buffer.byteLength(encoded) }).end(encoded);
}

function error(response, status, code, message) { send(response, status, { error: { code, message } }); }

function readBody(request, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (done) return;
      if (size > max) { done = true; reject(Object.assign(new Error("request body too large"), { status: 413 })); return; }
      chunks.push(chunk);
    });
    request.on("end", () => { if (!done) resolve(Buffer.concat(chunks)); });
    request.on("error", reject);
  });
}

async function json(request) {
  const body = await readBody(request);
  try { return JSON.parse(body.toString("utf8")); }
  catch { throw Object.assign(new Error("malformed JSON"), { status: 400 }); }
}

function validBookmark(input) {
  if (!input || typeof input !== "object") throw new Error("body must be an object");
  let parsed;
  try { parsed = new URL(input.url); } catch { throw new Error("url must be absolute"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("url must use http or https");
  if (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 200) throw new Error("title is required and must be at most 200 characters");
  if (input.tags !== undefined && !Array.isArray(input.tags)) throw new Error("tags must be an array");
  const tags = [];
  for (const tag of input.tags ?? []) {
    if (typeof tag !== "string" || !tag.trim() || tag.trim().length > 64) throw new Error("tags must contain non-empty strings");
    const normalized = tag.trim();
    if (!tags.includes(normalized)) tags.push(normalized);
  }
  return { url: parsed.href, title: input.title.trim(), tags };
}

const html = `<!doctype html><html><head><meta charset="utf-8"><title>LinkLedger</title><style>body{font:16px system-ui;max-width:760px;margin:3rem auto;padding:0 1rem}input{display:block;margin:.5rem 0;padding:.6rem;width:100%}button{padding:.6rem 1rem}li{margin:1rem 0}</style></head><body><h1>LinkLedger</h1><form id="form"><input name="url" type="url" placeholder="https://example.com" required><input name="title" placeholder="Title" required><input name="tags" placeholder="tags,comma,separated"><button>Add bookmark</button></form><ul id="list"></ul><script>
async function load(){const data=await fetch('/api/bookmarks').then(r=>r.json());list.innerHTML=data.items.map(x=>\`<li><a href="\${x.url}">\${x.title}</a> <button data-id="\${x.id}">Delete</button></li>\`).join('')}form.onsubmit=async e=>{e.preventDefault();const d=new FormData(form);await fetch('/api/bookmarks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:d.get('url'),title:d.get('title'),tags:d.get('tags').split(',').map(x=>x.trim()).filter(Boolean)})});form.reset();load()};list.onclick=async e=>{if(e.target.dataset.id){await fetch('/api/bookmarks/'+e.target.dataset.id,{method:'DELETE'});load()}};load();
</script></body></html>`;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") return send(response, 200, { status: "ok" });
    if (request.method === "GET" && url.pathname === "/") return send(response, 200, html, { "content-type": "text/html; charset=utf-8" });
    if (request.method === "POST" && url.pathname === "/api/bookmarks") {
      let fields;
      try { fields = validBookmark(await json(request)); } catch (caught) { if (caught.status) throw caught; return error(response, 400, "invalid_input", caught.message); }
      const bookmark = { id: randomUUID(), ...fields, createdAt: new Date().toISOString() };
      state.bookmarks.push(bookmark);
      await persist();
      return send(response, 201, bookmark);
    }
    if (request.method === "GET" && url.pathname === "/api/bookmarks") {
      const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) return error(response, 400, "invalid_limit", "limit must be from 1 to 50");
      let offset = 0;
      if (url.searchParams.has("cursor")) {
        try { offset = Number(Buffer.from(url.searchParams.get("cursor"), "base64url").toString("utf8")); } catch { return error(response, 400, "invalid_cursor", "cursor is invalid"); }
        if (!Number.isInteger(offset) || offset < 0) return error(response, 400, "invalid_cursor", "cursor is invalid");
      }
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const tag = url.searchParams.get("tag");
      const matching = [...state.bookmarks].reverse().filter((item) => (!q || item.title.toLowerCase().includes(q) || item.url.toLowerCase().includes(q)) && (!tag || item.tags.includes(tag)));
      const items = matching.slice(offset, offset + limit);
      const nextCursor = offset + limit < matching.length ? Buffer.from(String(offset + limit)).toString("base64url") : null;
      return send(response, 200, { items, nextCursor });
    }
    const match = url.pathname.match(/^\/api\/bookmarks\/([^/]+)$/);
    if (match && request.method === "GET") {
      const item = state.bookmarks.find((bookmark) => bookmark.id === decodeURIComponent(match[1]));
      return item ? send(response, 200, item) : error(response, 404, "not_found", "bookmark not found");
    }
    if (match && request.method === "DELETE") {
      const index = state.bookmarks.findIndex((bookmark) => bookmark.id === decodeURIComponent(match[1]));
      if (index < 0) return error(response, 404, "not_found", "bookmark not found");
      state.bookmarks.splice(index, 1);
      await persist();
      return send(response, 204);
    }
    error(response, 404, "not_found", "route not found");
  } catch (caught) {
    if (caught.status === 413) error(response, 413, "body_too_large", caught.message);
    else if (caught.status === 400) error(response, 400, "invalid_json", caught.message);
    else { console.error(caught); error(response, 500, "internal_error", "internal error"); }
  }
});

server.listen(port, host);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => { writes.finally(() => process.exit(0)); }));

