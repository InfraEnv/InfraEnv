# ADR-0002：Environment revision、Trash 与 Checkpoint

- 状态：Accepted
- 日期：2026-08-11

## 背景

用户需要保存拓扑，下次启动；也需要在实验中保存故障和 placement 状态。Docker 容器本身不适合作为可审阅、可迁移的课程存档，结构热改也容易让 Validator 和运行状态漂移。

## 决策

把持久对象拆成：

- Environment Definition：声明式拓扑与服务策略，按 revision/checksum 保存。
- Workspace Volume：用户文件，独立生命周期。
- Checkpoint：Instance 的虚拟时钟、任务、故障、服务和 placement。

编辑 Environment 只产生 staged revision，不热改运行 Instance。用户显式 Apply 后进入 `reconciling`；失败保持原 revision。删除 Environment 先进入 Trash，默认提示 7 天恢复窗口；Purge、Workspace 删除和 Checkpoint 删除分别确认。

当前 Alpha 实施注记：基础 Checkpoint 只保存 Snapshot 引用与活动节点；通用 Workspace 尚未创建。手动 Purge 会级联删除该 Environment 的 Snapshot 与 Checkpoint，并由 UI 在同一次破坏性确认中明确列出。

## 结果

- 课程 Preset 和历史结果可复现。
- CLI/UI 必须展示当前 revision 与 staged revision，使用乐观并发控制。
- Supervisor 需要垃圾回收、兼容性检查和 orphan reconciliation，但不得按名称模糊删除 Docker 资源。
