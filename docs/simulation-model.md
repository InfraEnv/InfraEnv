# SIMULATED / S2 模型

InfraEnv 的 S2 表示行为级、因果一致的对象模拟。它回答“一个链路故障会怎样传播到 Worker 等待与吞吐”，不回答“真实型号在特定内核、驱动、温度和拓扑下能跑多少”。

## 静态、动态与观测

目标模型分为三层；当前 Alpha 已完整实现第一层和 Snapshot 投影，通用动态状态仍是受控扩展点：

1. Hardware catalog 保存有来源的理论能力。
2. 当前 Instance state 保存生命周期、活动节点和 Runtime allocation；课程 Runtime 另有固定 Scenario 的观察/故障状态。通用虚拟时钟、workload、fault 与 placement 尚未接通。
3. Command/UI renderer 从同一 Snapshot 生成 `nvidia-smi`、拓扑、指标和 Web UI，不各自维护另一套硬件对象。

Snapshot 与持久学习记录携带 Environment checksum、seed 及内容/Runtime 版本；合成 benchmark 还展示模型口径和假设。面向兼容性的简短命令（例如 `nvidia-smi -L`）只保证明确的 `SIMULATED / S2` 标记，不声称包含全部溯源字段。相同 Snapshot、模型版本和 RNG 序列必须生成可复现的状态与事件。

## 有界性能估算

正常状态下的有效值使用可审阅的效率区间：

```text
effective = theoretical × efficiency(profile, workload, topology) × seededJitter
```

- `seededJitter` 在同一模型版本中确定，不随浏览器刷新改变。
- 无故障时有效带宽不得超过 catalog 理论上限。
- 共享链路先做 sharing/oversubscription，再计算端点有效值。
- 固定课程中的故障由声明式因果关系改变状态；通用 Playground fault API 当前禁用。
- 合成 benchmark 同时展示理论口径、估算值、seed 与假设；Web Metrics 当前只展示 Snapshot 中的 S2 估算值。

真实环境的微小偏差涉及固件、驱动、时钟、热状态、NUMA、消息大小和算法。S2 可以抽象这些因素，但不能用“小幅随机”伪装成实测分布。

## 启动状态机

当前通用 Playground 为每个 Snapshot 产生确定性的启动计划：

```text
provisioning → booting → self-testing → ready

plan: allocate → network → storage → runtime → workload
```

一次启动请求会同步完成这些状态转换；Web UI 随后按 Snapshot 的 modeled duration 展示 post-hoc Boot plan，并没有流式事件 WebSocket。更细的 firmware、PCIe enumeration、NVLink training 与 scheduler-ready 日志属于已接受但尚未接通的启动模拟目标。

## GPU 与内存

HBM、L2、每 SM shared memory 和未来 tensor shard 都只允许作为逻辑容量。当前 Hardware Catalog 保留正确的层级口径；通用 Runtime 尚未创建 Allocation/TensorShard/Placement 运行记录，也不会按虚拟容量分配同等大小的宿主 RAM。

`nvidia-smi`、`nvidia-smi topo -m`、`nvidia-smi nvlink -s` 和 `infraenv top` 是原创模拟 renderer，必须保留 Disclosure。普通 CUDA/NVML 程序仍会发现没有真实 Driver；InfraEnv 不伪装 `/dev/nvidia*`。

### Placement Ledger 基础库

`@infraenv/simulation` 已提供纯函数 `buildPlacementLedger`，可对 `MemoryPool`、`Allocation`、`ModelArtifact`、`TensorShard` 与 `PlacementPlan` 做稀疏 byte 记账和确定性校验。当前契约要求完整 shard 索引集合，且一个 Allocation 只能归属一个 shard；它会拒绝缺引用、容量越界、区间重叠、重复/缺失 shard index 与 allocation 复用。该函数不分配 HBM 等量的宿主内存，输出始终标记 `SIMULATED / S2`。

这只是未来推理课程可复用的模型基础，尚未接入通用 Instance、Checkpoint、CLI 或 Web UI Placement 面板。

## 精度升级

改变公式、默认效率区间或链路共享算法时必须提升 performance model version。当前 Snapshot 直接冻结已计算的 graph/boot/performance 与 checksum；显式模型迁移和差异/回滚协议仍属于后续契约工作，不能静默重算旧 Snapshot。
