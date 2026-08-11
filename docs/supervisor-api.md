# Supervisor `/api/v1`

Supervisor is a single-user, host-local control plane. It binds only loopback and returns JSON errors shaped as `{error,message,details?}`. The Docker course Sidecar keeps the separate private `/v1` protocol.

## Authentication and bootstrap

- `GET /health`, `/status`, and `/capabilities` expose non-secret readiness/capability data.
- Host CLI requests use `Authorization: Bearer ...`.
- `POST /auth/webui-launch` requires host authentication and returns a one-time origin-bound fragment URL.
- `POST /auth/exchange` consumes that token and sets an HttpOnly SameSite cookie.
- Browser mutations require matching Origin and `X-InfraEnv-CSRF`.

Collections return `{items: []}`. Web UI endpoints return compact projections; CLI requests append `?raw=true` where the canonical internal resource is required. Consumers must not guess one DTO from the other.

Environment import currently accepts only JSON export bundles. Before any mutation it verifies integrity hashes, unique Snapshot/Checkpoint IDs, Checkpoint→Snapshot ownership, and global object-ID isolation. `--replace` returns `409` while the Environment has an active Instance.

## Available resources

```text
GET|POST       /environments
GET|PUT|PATCH  /environments/:id
DELETE         /environments/:id
POST           /environments/:id/clone|start|stop|restore
GET|POST       /environments/:id/snapshots
GET|POST       /environments/:id/checkpoints
GET            /environments/:id/export
POST           /environments/import
GET            /environments/trash
POST           /environments/trash/:id/restore
DELETE         /environments/trash/:id

GET|POST       /instances
GET            /instances/:id
POST           /instances/:id/pause|resume|reset|restart|stop|reconcile
POST           /instances/:id/execute|node|checkpoints
POST           /instances/:id/checkpoints/:checkpointId/restore

GET            /presets
GET            /snapshots/:id
GET|POST       /checkpoints/:id[/restore]
```

`If-Match: <revision>` is accepted on Environment update and stale revisions return `409`. Model reconcile moves through the state machine and keeps the previous Snapshot if candidate validation fails. Docker reconcile is explicitly unavailable.

Delete moves an inactive Environment into Trash. There is no automatic garbage collector. Manual purge deletes the Environment, its Snapshots, Checkpoints, and terminal Instance records; an active reference blocks the destructive mutation.

## Capability-gated routes

The following routes exist so clients receive stable `501 capability_unavailable` responses; they are not current functionality:

```text
POST   /instances/:id/terminal-ticket
POST   /instances/:id/storage/connect
POST   /instances/:id/storage/loads
POST   /instances/:id/faults
DELETE /instances/:id/faults/:faultId
```

There is no browser terminal/event WebSocket in the general Playground alpha. The accepted protocol remains documented in ADRs as target state.
