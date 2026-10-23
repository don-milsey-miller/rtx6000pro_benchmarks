# HookBin

Create a self-hosted webhook inbox SaaS. It receives signed webhook deliveries,
stores them durably, lets the owner inspect them, and can replay a delivery to a
local development endpoint.

Start with `npm start`; bind to `HOST`/`PORT` and persist at `DATA_FILE`.

## API contract

- `GET /health` → `200 {"status":"ok"}`.
- `POST /api/inboxes` with `{"name":"..."}` creates an inbox and returns `201`
  with `{id,key,secret,name,createdAt}`. Keys and secrets must be unguessable.
- `POST /hooks/:key` accepts up to 256 KiB of raw bytes. Require
  `X-Hook-Signature: sha256=<lowercase hex HMAC-SHA256>` calculated over the exact
  bytes using the inbox secret. A valid delivery returns `202 {"id":"..."}`;
  invalid or missing signatures return `401`. Store method, content type, a safe
  representation of headers, exact body bytes, receive time, and replay history.
- Owner endpoints require `Authorization: Bearer <inbox secret>`.
- `GET /api/inboxes/:key/events` returns newest-first
  `{items,nextCursor}` and supports `limit` 1–100, opaque `cursor`, and optional
  `contentType` filter.
- `GET /api/inboxes/:key/events/:eventId` returns one event with its body encoded
  as base64, or `404`.
- `POST /api/inboxes/:key/events/:eventId/replay` accepts
  `{"targetUrl":"http://127.0.0.1:.../..."}`. For safety, only loopback HTTP
  targets are allowed. Send the original body and content type with an
  `X-HookBin-Replay: 1` header. Return `200` with the downstream status and append
  `{targetUrl,status,attemptedAt}` to replay history. Apply a five-second timeout.
- `DELETE /api/inboxes/:key/events` deletes that inbox's events and returns `204`.

Use consistent JSON errors. Malformed input, unknown inboxes, authorization
failures, oversized bodies, and downstream replay failures must not crash the
service or expose a secret.

## Persistence and UI

Concurrent deliveries and committed data must survive a restart without lost or
partially written records. `GET /` must serve a dependency-free HTML interface
that explains how to create an inbox and lets an owner enter a key/secret to list
events and inspect their payloads. Handle `SIGTERM` and `SIGINT` cleanly.

