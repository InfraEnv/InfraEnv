# InfraEnv Documentation

InfraEnv combines real host/Docker tools with explicitly labeled `SIMULATED / S2` hardware and cluster behavior. It is not a substitute for NVIDIA telemetry, NCCL/DCGM/Slurm, or production performance validation.

## Start here

- [v0.2 Alpha user manual](user/README.md)
- [Current capability status](user/status.md)
- [Generated CLI reference](cli-reference.md)
- [Developer manual](developer/README.md)
- [Architecture and state flow](developer/architecture.md)
- [Architecture decision records](adr/README.md)

## Reference pages

- [Web UI](web-ui.md)
- [Environment definition](environment-definition.md)
- [Simulation and performance model](simulation-model.md)
- [Supervisor API](supervisor-api.md)
- [Security and storage](security-and-storage.md)
- [Development and tests](development.md)

The user and API pages describe the current alpha. ADRs may describe accepted target-state design that remains capability-gated; every ADR is subordinate to the [status matrix](user/status.md).

```bash
npm run docs:generate
npm run docs:check
```

The first command regenerates the CLI reference from Commander metadata. The second rejects a stale generated reference, broken relative links, or missing required manual sections.
