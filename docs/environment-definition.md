# Environment Definition v0.2 Alpha

Environment 是可导出、可审阅的本地声明式定义。它只描述逻辑 S2 对象，不包含 Runtime token、Docker 名称、端口、S3 secret、容器 ID 或 Workspace 文件。

## Builder 输入与持久对象

Web UI 和 CLI 可以提交紧凑 JSON draft：

```json
{
  "name": "my-training-cluster",
  "seed": 240803,
  "inventory": {
    "rackCount": 1,
    "nodesPerRack": 4,
    "acceleratorsPerNode": 8,
    "acceleratorModel": "NVIDIA H100 SXM (SIMULATED)"
  },
  "topology": {
    "intraNode": "nvswitch",
    "nvlinkGeneration": "4",
    "interNode": "infiniband",
    "interRack": "fat-tree"
  },
  "workspace": { "persistent": false },
  "objectStorage": { "mode": "disabled" }
}
```

Supervisor 将其规范化为 `infraenv.io/v1alpha1` JSON：

```json
{
  "apiVersion": "infraenv.io/v1alpha1",
  "kind": "Environment",
  "metadata": {
    "id": "environment:my-training-cluster-8f3a2c",
    "name": "my-training-cluster",
    "createdAt": "...",
    "updatedAt": "...",
    "labels": {
      "infraenv.dev/accelerator-fidelity": "custom-unverified",
      "infraenv.dev/topology-fidelity": "custom-modeled"
    }
  },
  "spec": {
    "simulationLevel": "S2",
    "seed": 240803,
    "placement": { "rackCount": 1, "nodesPerRack": 4 },
    "nodes": [],
    "fabrics": [],
    "storage": []
  }
}
```

真实保存结果中的 `nodes`、`fabrics` 与 `storage` 是完整结构，示例为聚焦身份与 placement 而省略。CLI `env show` 和 JSON export 是当前权威格式；YAML 导入尚未启用。

## 身份、Revision 与 Preset

- Supervisor 以名称 slug 加随机后缀生成 ID；名称当前不要求全局唯一。
- 更新使用数字 revision 与 `If-Match`，陈旧写入返回 `409`。
- Snapshot 冻结规范化 Environment、展开后的 HardwareGraph、boot/performance 投影与 SHA-256 checksum。
- Purge 后可从完整、integrity 校验通过的 export bundle 重新导入同一 ID；当前没有永久 tombstone。
- 选择 Curriculum Preset 时，紧凑 Builder 只创建 `DERIVED / CUSTOM from id@version` 的可编辑副本，不冒充不可变 exact Preset。
- rack-form Preset 按 `system count × computeUnitCount × acceleratorsPerComputeUnit` 投影。例如一个 NVL72 rack 是 18 个计算节点、每节点 4 GPU，而不是一个 72-GPU 节点。

## 当前 HardwareGraph

Snapshot 展开 `cluster/rack/chassis/node/cpu-numa/pcie-root/pcie-switch/gpu/memory/nvswitch/nic-dpu/fabric-switch/storage-endpoint`。链路端点必须存在，并记录 kind、direction、generation、sharing group、oversubscription、health、带宽和延迟口径。

自定义 Accelerator 文本会标记 `CUSTOM / UNVERIFIED`；当前数值是显式的 S2 heuristic，不是已解析的官方 SKU 规格。Curriculum-owned exact/derived Preset 的静态规格与来源仍保留在独立硬件目录中。

## 当前校验边界

- rack 1–128，nodes/rack 1–128，accelerators/node 0–16。
- 展开后最多 1024 个逻辑节点和 4096 个逻辑 GPU。
- 所有图端点、ID、引用、数值范围和 Snapshot checksum 必须有效。
- 导入只接受 InfraEnv JSON export bundle，验证结构、大小和 integrity hash。
- 当前不接受 YAML、ZIP、任意 tag、脚本、表达式、生命周期 hook 或 archive path；因此也没有把尚不存在的 YAML/Zip 流程称为已实现安全能力。

## Runtime overlay

当前通用 Instance 记录生命周期、活动节点、Snapshot 与 Runtime allocation；boot/metric 从固定 Snapshot 投影。通用设备健康、workload、fault、storage load 与 placement 运行态尚未接通。基础 Checkpoint 只保存 Snapshot 引用与活动节点。

未来版本可以在不改变 Environment 静态定义的前提下增加版本化动态 overlay、catalog-resolved custom SKU 和 portable Workspace；这些目标不得静默改变旧 Snapshot。
