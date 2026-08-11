# InfraEnv v0.2 Alpha Developer Manual

This directory describes the code that exists in `0.2.0-alpha.0` and separates it from accepted target-state ADRs.

## Architecture and ownership

- Curriculum owns hardware facts, versioned Presets, courses, Scenarios, declarative Validators, and Portable Lesson documents.
- Supervisor owns the host registry, loopback API, browser session, model Instance lifecycle, and future Docker orchestration.
- Simulation owns deterministic graph expansion, S2 performance/boot models, and command rendering.
- Runtime remains the per-course Sidecar used by the Docker `Find Slow Worker` path.
- CLI and Web UI call Supervisor Application Services; the browser never operates Docker directly.

See [the architecture diagram and state flow](architecture.md).

## Contracts

The Runtime consumer synchronizes the self-contained `dist/profiles/runtime` Curriculum profile. The sync script verifies every profile-manifest artifact and generates a TypeScript data module. `Lab → Scenario@version → Preset@version → System/Fabric/Boot/Accelerator` resolution must use exact references.

The current local registry uses an internal `apiVersion/kind/metadata/spec` record and exposes separate canonical raw resources to the CLI plus compact projections to the Web UI. A future schema revision may replace this adapter, but consumers must never infer one shape from the other.

## Supervisor

The public prefix is `/api/v1`; the course Sidecar keeps its private `/v1`. Supervisor binds only `127.0.0.1`, enforces bearer or browser-cookie authentication, and requires same-origin plus CSRF for browser mutations. Web UI launch tokens are random, short-lived, origin-bound, and single-use.

Only capabilities in `/api/v1/status` or the Instance projection may enable UI actions. Unimplemented routes return a structured capability error.

## Simulation engine

Hardware is a hierarchical property graph. Performance is deterministic S2 capacity modeling, not cycle simulation. Every renderer must include the disclosure and keep local-node versus global-cluster views distinct.

The legacy course engine consumes a normalized compatibility Scenario derived from the canonical v2 profile; its adapter is isolated and tested. Never put the normalized compatibility object back into Curriculum snapshots.

## PTY and Sandbox

The accepted design is a Supervisor-owned terminal broker with distinct CLI attach and one-time browser WebSocket tickets. It is not implemented in the general Playground alpha and therefore must not be advertised. The existing course CLI still owns its foreground Docker Sandbox terminal.

No container may receive the Docker Socket or a host-directory bind mount. A future persistent Workspace must use a named volume and remain separate from tokens, credentials, and checkpoint metadata.

## Security and S3

The S3 transport validates and pins DNS answers for each request, blocks unsafe address classes and redirects, scopes keys to a configured bucket/prefix, and keeps credentials behind a non-serializable signer. Supervisor integration must add an OS Credential Store provider without adding secret fields to Environment documents.

Imports must validate structure, integrity, size, and path boundaries before registry mutation. Docker resources must carry InfraEnv ownership labels and be reconciled conservatively after Supervisor restart.

## Hardware catalog and Preset authoring

Facts belong in `infraenv-curriculum`, with exact `{id, version}` references, sources, verification dates, units, and confidence. NVLink and NVSwitch generations remain separate. Exact Presets lock published structure; modified or scaled layouts become derived; arbitrary layouts are freeform and display `CUSTOM / UNVERIFIED`.

The editable Builder currently records a derived relationship rather than claiming exact expansion. Do not silently keep `presetRef` after structural edits.

## Development workflow

```bash
npm run content:check
npm run lint
npm run build
npm run docs:check
npm test
```

Docker acceptance is separate:

```bash
npm run docker:build
npm run test:docker
```

When adding a CLI command, update Commander metadata and regenerate the checked-in reference. When adding a UI action, add a server capability, schema validation, authorization test, and disabled-state copy in the same change.
