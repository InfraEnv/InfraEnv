# InfraEnv

InfraEnv is a local-first learning runtime for AI infrastructure, HPC, cluster operations, and distributed-training diagnosis. Version `0.2.0-alpha.0` adds a general Environment/Snapshot/Instance control plane while preserving the runnable `Find Slow Worker` course lab.

> **SIMULATED / S2** — GPU inventory, fabrics, scheduler state, metrics, boot events, and performance values are behavioral models. They are not NVIDIA telemetry, certification, or measured HPC performance.

Node.js 22+ · npm workspaces · Apache-2.0 code · curriculum snapshot under its bundled licenses

## What works in this alpha

- A checksummed Curriculum v2 profile with 14 versioned hardware presets, exact references, sources, and a data-only portable lesson.
- Environment registry, immutable Snapshots, deterministic model Instances, Checkpoints, clone/import/export, manual Trash/restore/purge, optimistic revisions, and staged reconcile.
- A loopback-only Supervisor API, one-time Web UI launch tokens, HttpOnly cookies, Origin/CSRF checks, and separate canonical CLI versus Web UI projections.
- Node-scoped `nvidia-smi` dialects, `nvitop` compatibility alias, topology views, and HBM/P2P/collective/storage synthetic benchmarks. Simulated command output is labeled S2; benchmark reports additionally include seed and model assumptions.
- A same-origin multi-instance Web UI for Environment CRUD, aggregated topology, metrics, boot/events, and capability-gated controls.
- The existing Docker-backed `Find Slow Worker` course: real Ubuntu Bash plus a simulated 16×8 H100 cluster and declarative validation.
- A hardened S3-compatible transport library with DNS pinning, rebinding/metadata protection, prefix authorization, redirect refusal, timeouts, and download quotas. It is not yet wired to a Supervisor credential connector.

## Capability-gated or not yet connected

- Browser PTY/Web Terminal and CLI attach for general Playground Instances.
- The general Playground's two-container Sidecar + Sandbox lifecycle and persistent `/workspace` volume. General Instances currently default to the host S2 model.
- External S3 credential-store Connector, symbolic model loading, generic fault injection, device/link structural mutation, and arbitrary CUDA/NVML execution.
- Lossless expansion of every catalog Preset into the editable graph. Selecting a Preset in the current Builder is labeled `DERIVED / CUSTOM`, not an exact reference deployment.

The UI and API advertise only implemented capabilities; unavailable controls remain disabled and return an explicit capability error.

## Local model Playground

Install once and expose the repository CLI through your existing user-level npm `PATH`:

```bash
npm install
npm run build
npm run link:cli
```

After that, either command starts a loopback Supervisor, opens the Web UI, and keeps it alive in the foreground:

```bash
npm run playground
# or, from any directory:
infraenv webui
```

`npm run dev` performs a fresh full build before launching the same Playground. Use `npm run playground:no-open` on a headless terminal. When the command owns a new Supervisor it prints the process bearer token once; keep Terminal A running and copy the printed PowerShell assignment into Terminal B:

```powershell
$env:INFRAENV_SUPERVISOR_TOKEN = '<printed-process-token>'
infraenv template list
infraenv env create playground --nodes 4 --gpus-per-node 2 --gpu NVIDIA-H100-S2
infraenv env list
infraenv env start <environment-id-from-create-output>
infraenv instance list
infraenv nvidia-smi --instance <instance-id> --node compute-node-00
infraenv bench p2p --instance <instance-id> --node compute-node-00
infraenv webui <environment-id>
```

`infraenv webui` serves the built UI from the loopback Supervisor and issues a short-lived, single-use fragment token. It never places the Supervisor bearer token in the browser.

The global command is a local npm link, not a published package. Remove it with `npm unlink --global @infraenv/cli`; the repository and saved Environments are left untouched.

## Runnable Docker course

With Docker Desktop running:

```bash
npm run docker:build
infraenv doctor
infraenv lab list
infraenv lab start find-slow-worker --ui
```

Inside the real Ubuntu Sandbox:

```bash
nvidia-smi
sinfo
squeue
infraenv nodes
infraenv jobs
infraenv metrics network
infraenv metrics gpu
infraenv inspect node03
infraenv diagnose
infraenv lab submit --root-cause network.bandwidth_drop --target node03
infraenv fault clear fault:node03-bandwidth
infraenv lab submit
```

The course uses an internal Docker network, readonly roots, `no-new-privileges`, capability drop, process/resource limits, no Docker Socket, and no host-directory bind mount. Local JSONL learning records retain the Runtime, content, Scenario, and checksum versions.

## Repository map

```text
packages/shared            shared runtime and compatibility types
packages/protocol          JSON Schema validation and local protocol
packages/simulation        catalog resolver, S2 graph/model, command dialects
packages/supervisor        host registry, lifecycle, API, and Web UI host
packages/storage-gateway   simulated store and hardened S3-compatible transport
packages/runtime           single-course Runtime Sidecar
packages/cli               infraenv command line
apps/web-ui                React/Vite management UI
docker                     Runtime and Ubuntu Sandbox images
vendor/curriculum          generated, checksummed curriculum profile
docs                       user, developer, and ADR documentation
```

Start with [the manual](docs/README.md), [current capability status](docs/user/status.md), and [architecture notes](docs/developer/architecture.md). Nothing in this alpha is published to npm or a remote registry by these scripts.
