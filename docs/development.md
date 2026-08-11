# 开发与扩展

## Workspace 边界

- `packages/shared`：稳定公开类型。
- `packages/protocol`：Ajv/JSON Schema 和 API 负载。
- `packages/simulation`：确定性对象状态与因果模型。
- `packages/runtime`：单 Instance API、Command renderer 和 Validator 调用。
- `packages/cli`：宿主命令和 Docker 生命周期。
- `apps/web-ui`：Supervisor 客户端和 Direct Runtime 回退。
- `infraenv-curriculum`：课程、Lab、Scenario 和声明式 Validator 唯一编辑源。

多实例控制已经位于宿主 Supervisor；Docker 编排不会下放到 Runtime Sidecar。当前通用 Instance 默认是 host S2 model，双容器生命周期仍按 capability 门控。

## Web UI 开发

Terminal A（Vite proxy target 为 `127.0.0.1:7331`）：

```bash
npm run dev:supervisor
```

Terminal B（Vite 在 `127.0.0.1:4173` 提供 `/app`）：

```bash
npm run dev:ui
npm run build --workspace @infraenv/web-ui
```

Vite 将 `/api` 代理到开发 Supervisor 的 `127.0.0.1:7331`，将 `/v1` 代理到课程 Runtime 的 `127.0.0.1:8080`。CLI `infraenv supervisor serve` 的用户默认端口是 9090，不是 Vite 开发代理目标；构建后的 `/app/` 由 Supervisor 同源托管，不存在这个端口差异。UI 必须覆盖 loading、online、empty、API error、Direct Runtime 和 Offline。

前端不得内置假 Environment、Preset、Instance、Metric、Boot Event 或 Storage Object。Builder 的初始表单值是未保存 draft，不得出现在 Environment 列表或统计中。

## 新增硬件模板

模板属于版本化 hardware catalog，而非 React 组件。每项包含来源、验证日期、静态规格、互联约束和 Disclosure；课程只引用固定版本/checksum。官方品牌 Logo、CLI 文本或第三方 TUI 代码不能从网页截图复制。

## 新增 Command renderer

Renderer 输入统一 Snapshot，输出 stdout/stderr/exitCode：

1. 先解析受支持参数并拒绝不支持组合。
2. 第一屏持续出现 SIMULATED / S2。
3. 只读取模型对象，不使用独立随机源。
4. CLI 与 Web UI 对同一 revision 显示同一值。
5. 使用 golden tests 验证数量、Disclosure、错误和终端宽度。

`nvitop` 若作为兼容 shim，必须原创并说明并非 nvitop 项目本身；规范主命令为 `infraenv top`。

## 测试矩阵与当前覆盖

- 已自动覆盖：Curriculum/Profile Schema 与 checksum、v1 Scenario fixture adapter、确定性 graph/boot/performance、4096 GPU 边界、Registry/Snapshot/基础 Checkpoint/Reconcile、多实例数量限制、revision 冲突、loopback、Origin/CSRF、单次 launch token、Storage transport 安全和固定课程 Runtime/Validator。
- 已有但需本机 Docker 执行：固定课程的一组 Sidecar + Sandbox，验证内网、无 Docker Socket/host bind、完整课程闭环与清理。
- 尚未完成浏览器自动验收：键盘顺序、390/768/1440px 视觉回归、终端宽度 golden tests。当前只完成 TypeScript/Vite 构建和静态布局审查。
- 未来能力接通后补测：通用 Browser PTY、双容器、Workspace、orphan Docker recovery、两个并行容器实例隔离、通用 fault/storage/placement 运行态。

## 文档检查

```bash
node docs/check.mjs
```

检查脚本验证必需文档、单一 H1 和仓库内 Markdown 相对链接。根 `package.json` 的 `docs:check` 还会先检查由 Commander metadata 生成的 CLI reference 是否过期；检查过程不修改文件。
