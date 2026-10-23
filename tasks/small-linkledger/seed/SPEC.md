# LinkLedger

Create a small self-hosted bookmark SaaS with a JSON API and a usable browser
page. It must start with `npm start`, bind to `HOST` (default `127.0.0.1`) and
`PORT` (default `3000`), and persist data at `DATA_FILE`.

## API contract

- `GET /health` → `200 {"status":"ok"}`.
- `POST /api/bookmarks` accepts JSON with `url`, `title`, and optional `tags`.
  `url` must be an absolute `http:` or `https:` URL, `title` must be a non-empty
  string of at most 200 characters, and `tags` must be an array of non-empty
  strings. Trim the title and each tag, then collapse duplicate normalized tags
  while preserving their first occurrence. Return `201` with a generated `id`,
  normalized fields, and ISO-8601 `createdAt`.
- `GET /api/bookmarks` returns
  `{"items":[...],"nextCursor":string|null}` newest first. Support optional
  case-insensitive `q` search across title and URL, exact `tag`, `limit` from
  1–50 (default 20), and opaque `cursor`.
- `GET /api/bookmarks/:id` returns the record or `404`.
- `DELETE /api/bookmarks/:id` returns `204` or `404`.

Use JSON error bodies shaped as `{"error":{"code":"...","message":"..."}}`.
Malformed JSON, invalid input, unknown routes, and request bodies above 64 KiB
must not crash the service.

## Persistence and UI

Committed writes must survive a clean restart using the same `DATA_FILE`. Avoid
leaving a partially written data file. `GET /` must serve an HTML page containing
a form that can add a bookmark and JavaScript that can list and delete entries
through the API. It should be understandable without build tools.

Handle `SIGTERM` and `SIGINT` with a clean shutdown.

