# v0.2 Alpha Capability Status

| Capability | Status | Notes |
| --- | --- | --- |
| Curriculum v2 + 14 Presets | Available | Checksummed, versioned, source-backed profile |
| Environment/Snapshot/Instance registry | Available | Model-only Instance is the default |
| Clone/import/export/Trash | Available | Purge is manual and deletes Snapshots + Checkpoints |
| Checkpoint | Basic | Saves Snapshot reference + active node; dynamic model state is not yet captured |
| Reconcile | Available for model-only | Docker reconcile returns unavailable |
| `nvidia-smi`/topology/bench dialect | Available | Node-scoped, SIMULATED / S2 |
| Same-origin Web UI | Available | One-time launch, cookie, Origin/CSRF |
| Find Slow Worker Docker course | Available | Existing real Ubuntu two-container course path |
| Course Web UI steps/metrics/allowlisted faults | Available | Direct Runtime polling; no browser Shell |
| General Playground Docker Shell | Not connected | Docker lifecycle is not a complete Sidecar+Sandbox session |
| Browser PTY/Web Terminal | Not connected | `terminal.attach` is not advertised |
| Persistent Workspace volume | Not connected | Builder control is disabled |
| Simulated storage capacity/service object | Available | No put/list/load object catalog yet |
| External S3 Connector | Not connected | Hardened transport library exists; credentials/UI wiring does not |
| Generic faults/device/link mutation | Not connected | Course fault remains available in the fixed lab |
| CUDA/NVML/PyTorch virtual device ABI | Out of scope | Command renderer only; no fake driver |

`Available` means the implementation is present and participates in the repository's automated build/contract checks; browser-only behavior may still require the manual acceptance matrix. It does not turn S2 values into real hardware evidence.
