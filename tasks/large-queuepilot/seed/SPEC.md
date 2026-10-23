# QueuePilot

Build a small multi-tenant work-tracking SaaS for engineering teams. It needs a
JSON API, durable local persistence, live event updates, and a useful browser UI.

Start with `npm start`, bind to `HOST`/`PORT`, store data at `DATA_FILE`, and
read tenants from `TENANTS_JSON`, a JSON object mapping tenant IDs to bearer
tokens. Example: `{"alpha":"alpha-token","beta":"beta-token"}`.

All `/api` routes except `/health` require `Authorization: Bearer <token>`.
Resources and events must be strictly tenant-scoped.

## API contract

- `GET /health` → `200 {"status":"ok"}`.
- `POST /api/projects` accepts `{name}` and returns `201` with
  `{id,name,createdAt}`. `GET /api/projects` returns the caller's projects as a
  JSON array of `{id,name,createdAt}` objects.
- `POST /api/projects/:projectId/issues` accepts
  `{title,description?,priority?}` and returns `201`. Priority is one of
  `low|normal|high|urgent`, default `normal`. Support `Idempotency-Key`: repeating
  the same create request for the same tenant/key must return the original issue
  and must not duplicate audit or SSE events. A new issue has `status:"open"`
  and numeric `version:1`; the response includes those fields.
- `GET /api/issues` returns newest-first `{items,nextCursor}` with `limit` 1–100,
  opaque `cursor`, and optional `projectId`, `status`, `priority`, and
  case-insensitive `q` filters.
- `GET /api/issues/:id` returns the issue including comments and a numeric
  `version`.
- `PATCH /api/issues/:id` requires `If-Match: "<version>"`. Allow updates to
  title, description, priority, and these status transitions:
  `open→in_progress|closed`, `in_progress→open|closed`, `closed→open`.
  A stale or missing version returns `409`; success increments `version`.
- `POST /api/issues/:id/comments` accepts `{body}`, appends an immutable comment,
  increments the issue version, and returns `201`.
- `GET /api/audit` returns tenant-scoped newest-first `{items,nextCursor}` with
  `limit` and `cursor`. Record project creation, issue creation/update, comment,
  and idempotent create only once. Each event includes `id,type,resourceId,at` and
  a useful details object. Use the exact type strings `project.created`,
  `issue.created`, `issue.updated`, and `comment.created`.
- `GET /api/events` is an authenticated Server-Sent Events stream. Send an
  initial `ready` event, keep the connection alive, and publish tenant-scoped
  events named `project.created`, `issue.created`, `issue.updated`, and
  `comment.created`. Remove disconnected clients.

Use consistent JSON errors. Enforce sensible string limits, a 256 KiB body
limit, safe cursor parsing, and unknown-route handling. Malformed requests and
concurrent writes must not crash the process. Malformed JSON and invalid fields
return `400`; bodies above 256 KiB return `413` while leaving the service
healthy.

## Durability and user interface

Committed writes must survive restart without corrupting prior state. Serialize
or otherwise protect concurrent mutations, and use atomic file replacement.
Handle `SIGTERM` and `SIGINT` cleanly.

`GET /` must provide a dependency-free HTML/CSS/JavaScript dashboard where a
user can enter a token, view projects and filtered issues, create projects and
issues, update issue status, comment, and see live events. Do not embed tenant
tokens in generated HTML or logs. Include a short `OPERATIONS.md` explaining
configuration, persistence, health checks, and backup/restore.

