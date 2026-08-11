# ADR-0004：Web Terminal 使用宿主 PTY broker

- 状态：Accepted
- 日期：2026-08-11

## 背景

Workbench 要求右侧真实 Ubuntu Terminal，并与宿主 CLI 操作同一 Sandbox。Runtime Sidecar 无 Docker 权限；把任意 Shell 命令送到模拟 `/commands/execute` 会混淆真实 Bash 与模型命令，并绕过容器边界。

## 决策

Supervisor 在宿主创建 PTY，并附加 `docker exec -it` 到选定 Sandbox。浏览器先用 Cookie/CSRF 获取单次短效 ticket，再用返回的 `Sec-WebSocket-Protocol` 建立通道。ticket 不放 URL query、localStorage 或日志。

Terminal 数据面只连接选定 Sandbox；不能借此创建/删除其他 Instance。环境管理继续调用结构化 `/api/v1`。

## 结果

- CLI 与 Web UI 可以附加同一真实 Shell，同时保持模拟控制面声明式。
- Supervisor 必须处理 resize、断线回收、限速、空闲超时和危险终端控制序列。
- Direct Runtime 没有宿主 PTY broker 时，Web Terminal 明确禁用。

