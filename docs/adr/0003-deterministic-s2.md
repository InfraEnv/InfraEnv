# ADR-0003：确定性 S2 性能模型

- 状态：Accepted
- 日期：2026-08-11

## 背景

Playground 希望展示接近理论上限但带微小差异的显存和链路速度。若页面每次刷新随机，课程结果不可复现；若直接展示官方样式而不披露，又容易被误认为实测。

## 决策

性能值由 catalog 理论值、版本化 efficiency model、拓扑共享关系和持久 seed 计算。Jitter 是确定性的，有效值默认不超过理论上限。所有 CLI/UI 输出持续显示 `SIMULATED / S2`、理论值和模型值的区别。

改变公式或默认区间必须提升 performance model version；旧 Environment/Checkpoint 锁定原版本，除非显式迁移。

## 结果

- 相同定义、seed 和模型版本得到相同结果。
- 数值可用于学习因果关系，不可用于采购、真实容量规划或硬件排名。
- Hardware catalog 必须记录来源和验证日期，自定义型号显示 `CUSTOM / UNVERIFIED`。

