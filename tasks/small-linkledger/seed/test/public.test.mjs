import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startProduct, stopProduct } from "./test-helper.mjs";

let product;
before(async () => { product = await startProduct(); });
after(async () => { if (product) await stopProduct(product); });

test("creates and reads a bookmark", async () => {
  const created = await fetch(`${product.base}/api/bookmarks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/docs", title: "Example docs", tags: ["docs"] }),
  });
  assert.equal(created.status, 201);
  const record = await created.json();
  assert.ok(record.id);
  const found = await fetch(`${product.base}/api/bookmarks/${record.id}`);
  assert.equal(found.status, 200);
  assert.deepEqual((await found.json()).tags, ["docs"]);
});

test("lists, filters, and deletes bookmarks", async () => {
  const list = await fetch(`${product.base}/api/bookmarks?q=example&tag=docs&limit=10`);
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.ok(Array.isArray(body.items));
  assert.equal(body.items.length, 1);
  assert.equal(body.nextCursor, null);
  const removed = await fetch(`${product.base}/api/bookmarks/${body.items[0].id}`, { method: "DELETE" });
  assert.equal(removed.status, 204);
});

test("serves a browser interface", async () => {
  const response = await fetch(`${product.base}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.match(html, /<form/i);
  assert.match(html, /\/api\/bookmarks/);
});

