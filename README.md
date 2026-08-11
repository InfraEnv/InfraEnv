# InfraEnv

InfraEnv is a portable learning runtime for AI infrastructure, HPC, cluster
operations and distributed-training diagnosis. It gives learners a **real
Ubuntu shell** inside a constrained Docker sandbox while a deterministic
TypeScript sidecar simulates the cluster control plane.

> Every simulated command and screen says **SIMULATED / S2**. GPU, network,
> scheduler and performance values teach causal behavior; they are not real
> H100, NCCL, Slurm or HPC performance measurements.

Version: `0.1.0-alpha.0` · Node.js 22+ · Apache-2.0

## First runnable lab

`Find a Slow Worker` models a 16-node training job with eight logical H100 GPUs
per node. At virtual T+40 seconds, `node03` drops from 400 Gbps to 20 Gbps. The
resulting communication stall increases synchronization wait and step time,
then reduces throughput. A learner must inspect evidence, submit a hypothesis,
repair the fault and pass declarative checks.

```bash
npm install
npm run build
npm run docker:build
npm link packages/cli

infraenv doctor
infraenv lab list
infraenv lab start find-slow-worker --ui
```

Inside the sandbox, run the complete strictly whitelisted lab sequence:

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

The first alpha is local-only. It does not require a physical GPU, an account,
telemetry, MinGW, or Internet access at lab runtime.

## Architecture

```text
Host CLI
  ├─ Runtime sidecar (Fastify + WebSocket + React UI)
  │    ├─ deterministic S2 scenario engine
  │    ├─ declarative validator
  │    └─ local JSONL learning record
  └─ Ubuntu 24.04 sandbox
       ├─ real bash / Python / GCC
       └─ thin nvidia-smi / sinfo / squeue / infraenv RPC shims
```

The npm workspace contains `shared`, `protocol`, `simulation`, `validator`,
`runtime`, and `cli` packages plus `apps/web-ui`. Runtime semantics never live
in the Python shims. Curriculum validators are data-only and cannot execute
JavaScript, Python, shell hooks or package lifecycle scripts.

## Local API

The sidecar is dual-homed on a session-internal network and a separate
runtime-only host bridge, exposing only a random host port on `127.0.0.1`.
The sandbox joins only the internal network and therefore has no egress path.
The `/v1` API
includes session state, nodes, jobs, metrics, command execution, pause/resume/
reset, fault injection/clearing, lab submission and a WebSocket event stream.
Host, sandbox and UI credentials are separate; the UI exchanges a single-use
launch token for an HttpOnly SameSite cookie. UI credentials can read state and
invoke only pause/resume/reset or Scenario-listed fault actions. Sandbox
credentials can execute only the Scenario command whitelist, including this
lab's named repair and declarative submission operations. The host CLI can run
the same management flow from a second terminal; direct sandbox access to
management API routes remains forbidden.

## Curriculum synchronization

`vendor/curriculum` is a committed, generated, **DO NOT EDIT** runtime profile.
The curriculum repository remains the editing source of truth:

```bash
# Build ../infraenv-curriculum first
npm run content:sync
npm run content:check
```

The consumer reads only
`../infraenv-curriculum/dist/profiles/runtime/catalog.json`, writes a canonical
snapshot, and commits its SHA-256 metadata. This keeps runtime releases
reproducible before `@infraenv/curriculum` is published.

## Development checks

```bash
npm run lint
npm run content:check
npm test
```

Docker-dependent end-to-end validation is intentionally separate because
unit and API integration tests do not require a running daemon.

## Security boundary

See [SECURITY.md](SECURITY.md). In short: per-session internal Docker network,
no Docker socket mount, no privileged containers, read-only roots,
`no-new-privileges`, all capabilities dropped, process/memory/CPU limits,
tmpfs scratch space, no sandbox egress and loopback-only API/UI publishing.
The narrowly scoped named volume retains local JSONL progress without exposing
a host directory to either container.
