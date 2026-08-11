# ADR-0005：对象存储使用受限宿主 Connector

- 状态：Accepted
- 日期：2026-08-11

## 背景

真实训练和推理会从 S3/Object Storage 读取权重，但 Sandbox 默认无公网，并且课程定义、浏览器和 JSONL 都不应持有真实凭据。

## 决策

默认提供纯符号 simulated object catalog。真实 S3 是可选宿主 Connector：secret 保存在 OS Credential Store，Environment 只引用 connector ID。Sandbox 只访问内部受限代理，不能直连任意 endpoint。

Connector 默认只读并固定 bucket/prefix，执行 TLS、SSRF、metadata、重定向、大小、并发和带宽限制。Web UI 只允许选择已配置 Connector，不收集 Access Key。

## 结果

- 课程能表达“对象存储→缓存→HBM placement”的流程而不下载大文件。
- 真实连接不会破坏 Sandbox 默认无公网边界。
- Connector 作为后续可选 capability；缺失时 UI 入口可见但禁用，不伪造连接成功。

