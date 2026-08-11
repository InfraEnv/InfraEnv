# InfraEnv v0.2 Alpha User Manual

InfraEnv has two usable paths today:

1. A host-side, model-only Playground for creating, saving, inspecting, and reconciling S2 Environments.
2. The Docker-backed `Find Slow Worker` course, which opens a real Ubuntu Bash Sandbox.

The general Playground Web Terminal, persistent Workspace volume, external S3 Connector, and generic fault controls are capability-gated and remain disabled in this alpha. See [the status matrix](status.md) before following a workflow.

## Installation

Requirements are Node.js 22+, npm, and—only for the Docker course—Docker 26+ with Docker Desktop running.

```bash
npm install
npm run content:check
npm test
npm run link:cli
```

No npm package, cloud service, account, or telemetry endpoint is required.

For the shortest local startup, run `npm run playground` after the first build. `npm run dev` first rebuilds every workspace, while `npm run playground:no-open` starts the same loopback service without opening a browser. The linked `infraenv` command works from any directory because the user's npm bin directory is already on `PATH`.

## Playground and CLI

Run `npm run playground` or `infraenv webui` in Terminal A. It starts the loopback Supervisor, opens the same-origin UI, and prints a process token once. Keep Terminal A running and copy the printed PowerShell assignment into each client terminal. The token is not written to the Supervisor state file.

```bash
infraenv template list
infraenv env create demo --nodes 4 --gpus-per-node 2 --gpu NVIDIA-H100-S2
infraenv env list
infraenv env start <environment-id>
infraenv instance list
infraenv nvidia-smi --instance <instance-id> --node compute-node-00
infraenv topology --instance <instance-id> --node compute-node-00
infraenv bench all --instance <instance-id> --node compute-node-00
```

Environment IDs and Instance IDs come from create/start output; do not guess or reuse them. `env use` and `node use` can save the active non-secret context locally.

## Web UI

After `npm run build`, run `infraenv webui [environment-id]`. The Supervisor serves `/app/` on loopback, generates a one-time fragment token, and exchanges it for an HttpOnly SameSite cookie. The browser never receives the host bearer token or Docker control capability.

The UI currently supports Environment CRUD, snapshots/revisions, model Instance lifecycle, aggregated topology, metrics, boot/events, Checkpoints, Trash, and reconcile. Terminal, external S3, symbolic load, and generic faults are shown only as disabled capability-gated panels.

## Templates and topology

`template list` returns hierarchy-aware summaries and `template show <id@version>` returns the immutable Curriculum Preset. `exact`, `derived`, and `freeform` describe the source architecture. In the editable Builder, choosing a template records a `DERIVED / CUSTOM from ...` relationship; it does not claim the edited graph is still the exact reference design. Rack-form systems expand by system instances × compute trays × GPUs per tray, so an NVL72 rack is never flattened into one 72-GPU node.

Node commands are local-node views. `nvidia-smi` never displays the entire cluster; use `infraenv nodes`, `infraenv topology`, or `infraenv exec <environment> --all -- <command>` for global inspection.

Large Web UI views aggregate by rack and node. The current soft limit is enforced before graph expansion; topology values remain S2 abstractions.

## Performance and faults

Benchmarks print theoretical ceilings, modeled values, seed, model confidence, and assumptions. They are not measurements and must not be used for purchasing or production capacity planning.

Generic Playground fault injection is not connected. The `Find Slow Worker` course retains its declarative, allowlisted bandwidth fault and Validator path.

## Save, restore, and Trash

Snapshots freeze an Environment revision. In this alpha, Checkpoints save a Snapshot reference and active node context; virtual time, faults, jobs, placements, and Workspace files are not yet captured. Export bundles contain configuration, snapshots, these basic checkpoints, and integrity hashes, but never host tokens or S3 credentials.

Delete moves an Environment into Trash. The displayed seven-day timestamp is an eligibility hint, not an automatic garbage collector. `restore` recovers it; explicit `purge --yes` permanently removes the Environment, Snapshots, Checkpoints, and stopped/failed Instance records. General Playground Workspace volumes are not yet created.

## Object storage and S3

The Environment model can add a simulated storage capacity/service node and synthetic storage benchmark. It does not yet expose an object put/list/load catalog. The storage package contains a hardened S3-compatible transport, but the Supervisor credential-store Connector is not connected, so `storage.connect` and symbolic load are unavailable.

The transport defaults to read-only, pins verified DNS results, blocks metadata/private/link-local destinations, rejects redirects, scopes bucket/prefix operations, separates PUT/DELETE grants, and enforces time and size limits. Local MinIO requires explicit local and insecure switches.

## Docker course

Build images and run the course:

```bash
npm run docker:build
infraenv doctor
infraenv lab start find-slow-worker --ui
```

The course uses a real Ubuntu Shell and fixed 128-GPU S2 Scenario. Follow the lesson's 12 commands, identify `network.bandwidth_drop` on `node03`, clear the fault, and submit again. Exiting the foreground Sandbox cleans its containers and networks while retaining the local learning record volume.

## Troubleshooting

- If `doctor` reports Docker unavailable, start Docker Desktop. InfraEnv does not use MinGW as a Linux substitute.
- If the Supervisor returns `401`, set the current process token in `INFRAENV_SUPERVISOR_TOKEN`; it is intentionally not persisted.
- If `webui` cannot start, run the full build and confirm the Supervisor is bound to loopback.
- If a control is disabled, inspect `infraenv supervisor capabilities`; the UI does not synthesize success for unavailable capabilities.
- If a generated curriculum checksum fails, run `npm run content:sync` from this repository after building the sibling `infraenv-curriculum` repository.

For implementation details, continue with the [developer manual](../developer/README.md).
