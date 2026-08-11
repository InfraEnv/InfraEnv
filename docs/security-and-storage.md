# Security and Storage

## Current trust boundaries

- Supervisor binds loopback and is the only component allowed to invoke host Docker tooling.
- Browser authentication uses an origin-bound, single-use launch token, then an HttpOnly SameSite cookie plus CSRF for mutation.
- Tokens are not put in URL queries, Environment documents, export bundles, Checkpoints, or learning records.
- The tested Docker course uses internal networks, readonly roots, `no-new-privileges`, capability drop, PID/memory/CPU limits, no Docker Socket, and no host-directory bind mount.
- The general model Instance has no container, PTY, or Workspace and does not claim otherwise.

## Simulated storage

`MemoryS3Backend` is an internal registry/test primitive, not a user-facing Playground object catalog. It is separate from real S3-compatible I/O. Environment storage nodes and storage benchmark values currently remain S2 capacity/service objects with no put/list/load workflow.

## Hardened S3-compatible transport

The storage package includes an external transport library with these tested properties:

- HTTPS and read-only by default.
- Explicit double opt-in for local/insecure MinIO.
- DNS resolution on every request and connection pinned to the verified address.
- Blocking for metadata, loopback, private, link-local, reserved, and IPv4-mapped unsafe addresses.
- Redirect refusal, fixed bucket/prefix, independent PUT and DELETE prefix grants.
- Content-Length and streamed-byte quotas plus timeout across DNS, signing, headers, and body.
- Credentials behind a non-serializable signer interface; sensitive descriptor fields and protected-header override are rejected.

The Supervisor does not yet provide an OS Credential Store signer or Storage Gateway container. Therefore the Web UI and `/storage/connect|loads` routes remain disabled. Sandbox never receives a real credential or arbitrary egress path.

## Future PTY and Workspace

The accepted design uses a Supervisor-owned PTY broker and a per-Environment Docker named volume at `/workspace`. Neither is implemented for the general Playground alpha. ADRs describe the intended security invariants, not a claim that the capability already exists.
