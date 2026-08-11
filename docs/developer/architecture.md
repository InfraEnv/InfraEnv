# Architecture and State Flow

```text
Curriculum profile (immutable, checksummed)
                  │
                  ▼
Hardware Catalog → Preset → editable Environment
                                │
                                ▼
                        immutable Snapshot
                                │
                                ▼
                    running model Instance
                                │
                 ┌──────────────┴──────────────┐
                 ▼                             ▼
          Host CLI                    Same-origin Web UI
                 └────────── Supervisor /api/v1 ──────────┘

Course path today:
Lesson + Lab Policy + Scenario Patch + Preset
                                │
                                ▼
                 Runtime Sidecar ↔ Ubuntu Sandbox
```

Environment is editable intent. Snapshot freezes the graph, references, checksum, modeled result, and seed. Instance is runtime state attached to one Snapshot. The current basic Checkpoint stores the Snapshot reference and active node; richer virtual-time/fault/job/placement capture remains the accepted target design. A Checkpoint is never a Docker image. Course mode locks structural edits; a future Fork operation creates a Playground Environment.

The general Playground alpha runs the S2 model in the host Supervisor. The diagram deliberately keeps the target Sidecar+Sandbox broker out of that current path until its capability is implemented and tested.
