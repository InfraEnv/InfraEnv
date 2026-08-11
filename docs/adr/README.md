# Architecture decision records

ADR 记录 InfraEnv v0.2 中跨 CLI、Supervisor、Runtime、Sandbox、Web UI 与 Curriculum 的稳定边界。ADR 是已接受的目标设计，不代表对应能力已经接通；当前实现状态以 [Capability Status](../user/status.md) 为准。

- [ADR-0001：宿主 Supervisor 与每实例 Runtime](0001-host-supervisor.md)
- [ADR-0002：Environment revision、Trash 与 Checkpoint](0002-environment-lifecycle.md)
- [ADR-0003：确定性 S2 性能模型](0003-deterministic-s2.md)
- [ADR-0004：Web Terminal 使用宿主 PTY broker](0004-terminal-broker.md)
- [ADR-0005：对象存储使用受限宿主 Connector](0005-storage-connector.md)

状态使用 Proposed、Accepted、Superseded 或 Rejected。改变 Accepted 决策应新增 ADR，并在旧记录中添加替代链接，而不是重写历史原因。
