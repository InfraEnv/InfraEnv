# ADR-0001：宿主 Supervisor 与每实例 Runtime

- 状态：Accepted
- 日期：2026-08-11

## 背景

v0.1 CLI 直接创建一个 Runtime Sidecar 和一个前台 Sandbox，只保存单个 `session.json`。Web UI 位于 Sidecar 内，无法安全地枚举、创建或删除其他 Docker 实例。把 Docker Socket 挂进 Sidecar 会扩大浏览器和课程内容的权限边界。

## 决策

新增只运行在宿主的 Supervisor。CLI 与 Web UI 都通过 loopback `/api/v1` 调用 Supervisor；Supervisor 使用 Docker CLI 管理实例。每个运行 Instance 继续拥有独立 Runtime Sidecar、Sandbox、内部网络和命名 volume。

Runtime 负责单 Instance 模拟和 Validator，不负责创建容器。Sandbox 与 Sidecar 均不获得 Docker Socket。浏览器只持有 Supervisor Cookie/CSRF，不获得 Runtime bearer token。

## 结果

- 多实例 CRUD、reconciliation 和 Web Terminal 有统一入口。
- Supervisor 成为高权限本地进程，必须严格校验 Origin、Host、输入、ownership label 和资源配额。
- v0.1 Sidecar UI 可通过 Direct Runtime 回退继续使用，但不会拥有多实例能力。

