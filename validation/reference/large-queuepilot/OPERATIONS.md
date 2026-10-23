# QueuePilot operations

Run on Linux with Node.js 24. Set `HOST`, `PORT`, `DATA_FILE`, and
`TENANTS_JSON`; the last value maps tenant identifiers to bearer tokens. Probe
`GET /health` for service health.

QueuePilot atomically replaces `DATA_FILE` after committed changes. Back up the
file only after stopping the process cleanly or from a filesystem snapshot.
Restore by stopping QueuePilot, replacing `DATA_FILE` with the backup, checking
ownership, and starting the service again with the same `TENANTS_JSON` mapping.

Send `SIGTERM` for graceful shutdown. Protect the listen port with TLS at a
reverse proxy and store bearer tokens in a secret manager rather than a checked
in environment file.

