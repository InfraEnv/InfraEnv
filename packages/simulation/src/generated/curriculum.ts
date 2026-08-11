/* SPDX-License-Identifier: CC-BY-4.0 */
/* DO NOT EDIT — generated educational data from vendor/curriculum/catalog.json by content:sync. */
import type { LabDefinition, RuntimeCurriculumProfile, ScenarioDefinition } from "@infraenv/shared";

export const runtimeCurriculumProfile = {
  "chapters": [
    {
      "courseId": "course:ai-infra-operations",
      "englishTitle": "Distributed Training Diagnostics",
      "id": "chapter:distributed-training-diagnostics",
      "lessonIds": [
        "lesson:find-slow-worker"
      ],
      "slug": "distributed-training-diagnostics",
      "summary": "从全局吞吐异常出发，沿指标、节点和网络证据定位同步训练中的慢 Worker。",
      "title": "分布式训练诊断"
    }
  ],
  "courses": [
    {
      "audience": "已掌握 Linux 基础，希望建立生产级 AI 集群故障诊断思维的学习者。",
      "chapterIds": [
        "chapter:distributed-training-diagnostics"
      ],
      "englishTitle": "AI Infrastructure Operations",
      "id": "course:ai-infra-operations",
      "slug": "ai-infra-operations",
      "summary": "在明确标注的行为模拟集群中练习观察、定位、破坏、修复和验证。",
      "title": "AI Infra 运维与诊断"
    }
  ],
  "labs": [
    {
      "allowedUiActions": [
        "pause",
        "resume",
        "reset",
        "inject-listed-fault",
        "clear-listed-fault"
      ],
      "id": "lab:find-slow-worker",
      "lessonId": "lesson:find-slow-worker",
      "requirements": {
        "cpuCores": 2,
        "diskMiB": 1536,
        "docker": ">=26",
        "memoryMiB": 2048,
        "networkAccessDuringLab": false,
        "node": ">=22",
        "operatingSystems": [
          "Windows 11 with Docker Desktop",
          "Linux with Docker Engine",
          "macOS with Docker Desktop"
        ],
        "realGpuRequired": false
      },
      "scenarioRef": {
        "id": "scenario:slow-worker-bandwidth-drop",
        "version": "1.0.0"
      },
      "simulationLevel": "S2",
      "slug": "find-slow-worker",
      "steps": [
        {
          "command": "infraenv doctor",
          "expectedObservation": "Docker 可用、Runtime 与 Sandbox 镜像就绪；不要求真实 GPU。",
          "hint": "Docker 未启动时先启动 Docker Desktop，不要尝试使用 MinGW 替代 Linux。",
          "id": "step:doctor",
          "instruction": "在宿主终端确认 Node.js 与 Docker 能满足实验要求。",
          "kind": "command",
          "order": 1,
          "title": "检查本机运行条件"
        },
        {
          "command": "infraenv lab list",
          "expectedObservation": "列表包含 find-slow-worker，标记为 SIMULATED / S2。",
          "hint": "若列表为空，检查课程快照版本和 checksum。",
          "id": "step:list-labs",
          "instruction": "确认 Find Slow Worker 已从课程快照加载。",
          "kind": "command",
          "order": 2,
          "title": "查看可用实验"
        },
        {
          "command": "infraenv lab start find-slow-worker --ui",
          "expectedObservation": "进入真实 Ubuntu bash，提示符持续展示 SIMULATED / S2，会话 UI 绑定 127.0.0.1 随机端口。",
          "hint": "Runtime 不应挂载 Docker Socket，也不应把宿主目录暴露给 Sandbox。",
          "id": "step:start-lab",
          "instruction": "启动 Runtime Sidecar、Ubuntu Sandbox 和本地只读观察 UI。",
          "kind": "command",
          "order": 3,
          "title": "启动隔离会话"
        },
        {
          "command": "nvidia-smi",
          "expectedObservation": "当前节点显示 8 张 NVIDIA H100 SXM (SIMULATED)，输出明确标注不是真实遥测。",
          "hint": "清单数量用于拓扑推理，不能作为硬件性能基准。",
          "id": "step:inspect-gpu-inventory",
          "instruction": "检查节点内可见的逻辑 GPU 与模拟披露信息。",
          "kind": "observe",
          "order": 4,
          "title": "观察虚拟 GPU 清单"
        },
        {
          "command": "sinfo && squeue && infraenv nodes && infraenv jobs",
          "expectedObservation": "16 个节点、128 张虚拟 GPU 和一个运行中的同步训练作业，没有节点完全宕机。",
          "hint": "部分性能故障不会让调度器把节点标成 DOWN。",
          "id": "step:inspect-scheduler",
          "instruction": "先看节点状态，再确认训练作业仍在运行。",
          "kind": "observe",
          "order": 5,
          "title": "检查集群与任务"
        },
        {
          "command": "infraenv metrics network",
          "expectedObservation": "虚拟 T+40 秒后 node03 带宽从 400 Gbps 降至 20 Gbps，其他节点保持基线附近。",
          "hint": "优先比较同一时间窗口内的节点差异。",
          "id": "step:network-metrics",
          "instruction": "查找相对基线显著偏离的节点链路。",
          "kind": "observe",
          "order": 6,
          "title": "对比网络指标"
        },
        {
          "command": "infraenv metrics gpu",
          "expectedObservation": "Worker03 通信变慢，其他 Worker 同步等待增加，全局 Step Time 上升且吞吐下降。",
          "hint": "多数 GPU 同时空闲不意味着多数 GPU 同时损坏。",
          "id": "step:gpu-metrics",
          "instruction": "查看 GPU 空闲、同步等待、Step Time 和吞吐的共同变化。",
          "kind": "observe",
          "order": 7,
          "title": "关联 GPU 与训练指标"
        },
        {
          "command": "infraenv inspect node03",
          "expectedObservation": "node03 显示链路带宽异常及对应 Worker 通信等待，但 Runtime 不直接给出最终答案。",
          "hint": "将节点异常与训练时间线对齐。",
          "id": "step:inspect-node03",
          "instruction": "查看 node03 的链路、Worker 和故障事件证据。",
          "kind": "diagnose",
          "order": 8,
          "title": "深入检查候选节点"
        },
        {
          "command": "infraenv diagnose",
          "expectedObservation": "输出指向网络与慢参与者的候选方向，不直接显示根因和目标的答案组合。",
          "hint": "diagnose 是证据摘要，不是答案生成器。",
          "id": "step:diagnose",
          "instruction": "让诊断器汇总相关性，保留你自己的因果判断。",
          "kind": "diagnose",
          "order": 9,
          "title": "获取候选诊断"
        },
        {
          "command": "infraenv lab submit --root-cause network.bandwidth_drop --target node03",
          "expectedObservation": "诊断正确，但由于故障仍处于 active 且指标未恢复，实验状态为 not-yet-passed。",
          "hint": "正确答案只是闭环的一部分。",
          "id": "step:submit-diagnosis",
          "instruction": "在修复前记录根因和目标，验证诊断是否准确。",
          "kind": "submit",
          "order": 10,
          "title": "提交根因判断"
        },
        {
          "command": "infraenv fault clear fault:node03-bandwidth",
          "expectedObservation": "故障状态变为 cleared，node03 带宽与训练指标按确定性模型恢复。",
          "hint": "清除后等待一个虚拟采样窗口再提交。",
          "id": "step:clear-fault",
          "instruction": "只清除 Scenario 白名单中的 node03 带宽故障。",
          "kind": "repair",
          "order": 11,
          "title": "清除带宽故障"
        },
        {
          "command": "infraenv lab submit",
          "expectedObservation": "所有验证项通过，结果记录内容、Runtime、Scenario 版本和资产 checksum。",
          "hint": "若未通过，逐项查看缺失观察或未恢复指标。",
          "id": "step:final-submit",
          "instruction": "让声明式 Validator 检查完整证据、修复状态与关键指标。",
          "kind": "submit",
          "order": 12,
          "title": "验证恢复并完成实验"
        }
      ],
      "title": "Find Slow Worker",
      "validators": [
        {
          "id": "validator:network-observed",
          "kind": "observation-recorded",
          "observation": "metrics.network"
        },
        {
          "id": "validator:gpu-observed",
          "kind": "observation-recorded",
          "observation": "metrics.gpu"
        },
        {
          "id": "validator:node-inspection-observed",
          "kind": "observation-recorded",
          "observation": "node.inspect"
        },
        {
          "id": "validator:node03-inspected",
          "kind": "target-inspected",
          "target": "node03"
        },
        {
          "id": "validator:diagnosis-correct",
          "kind": "diagnosis-matches",
          "rootCause": "network.bandwidth_drop",
          "target": "node03"
        },
        {
          "faultId": "fault:node03-bandwidth",
          "id": "validator:fault-cleared",
          "kind": "fault-state",
          "state": "cleared"
        },
        {
          "id": "validator:bandwidth-restored",
          "kind": "metric-threshold",
          "metric": "node03.network.bandwidth_gbps",
          "operator": "gte",
          "unit": "Gbps",
          "value": 380
        },
        {
          "id": "validator:step-time-restored",
          "kind": "metric-threshold",
          "metric": "training.step_time_ms",
          "operator": "lte",
          "unit": "ms",
          "value": 200
        }
      ]
    }
  ],
  "lessons": [
    {
      "bodyAsset": "mdx/lessons/find-slow-worker.zh-CN.mdx",
      "chapterId": "chapter:distributed-training-diagnostics",
      "duration": "45–60 分钟",
      "englishTitle": "Find the Slow Worker",
      "id": "lesson:find-slow-worker",
      "labIds": [
        "lab:find-slow-worker"
      ],
      "prerequisiteTopicIds": [
        "topic:linux-shell",
        "topic:distributed-systems",
        "topic:multi-gpu-collectives",
        "topic:distributed-training"
      ],
      "slug": "find-slow-worker",
      "summary": "在 128 张虚拟 H100 的 S2 行为模拟中定位 node03 的带宽下降，修复后用指标证明恢复。",
      "teachesConceptIds": [
        "concept:observability",
        "concept:distributed-training",
        "concept:collectives",
        "concept:topology",
        "concept:fault-tolerance"
      ],
      "title": "找出拖慢训练的 Worker",
      "usesToolIds": [
        "tool:nccl",
        "tool:pytorch",
        "tool:prometheus",
        "tool:grafana"
      ]
    }
  ],
  "manifest": {
    "contentVersion": "0.1.0-alpha.0",
    "defaultLocale": "zh-CN",
    "integrity": {
      "catalog/cases.json": "sha256-60b53435598ee8309f401b22beda9e0561cd3ed6a8ef2951e46c4f5ad6abbf57",
      "catalog/concepts.json": "sha256-7fb953db6b7bbadd159e36fd2ca7fef259942656b35073b656439ac8ef8be0f2",
      "catalog/tools.json": "sha256-b29b5958087cc0853e3964693829ec03300c975bb6001ff7cf72bb696e6e44c0",
      "catalog/topics.json": "sha256-82a114a48714861715b9e70e1194119f92f244b0cf3f0154918829438d2d30f8",
      "courses/ai-infra-operations/chapters/distributed-training-diagnostics.yaml": "sha256-d4626f4aef25003383b0e75f45aa80fea16f01ca8e3cb20a47aa7f154e139a95",
      "courses/ai-infra-operations/course.yaml": "sha256-1cfd9bda6c5099920b479377ad9976eb8d9d3aa69625a0d1634225d744c4368a",
      "courses/ai-infra-operations/lessons/find-slow-worker.yaml": "sha256-d8b43ce9162412feafdda604869606e3d98ba3dab0016bd28e92b21d544bd194",
      "labs/find-slow-worker.yaml": "sha256-05b7c5af29a46882a29b8b3d0b7859f3be31fcae524fd598fb671c7f9f9207e8",
      "LICENSE.md": "sha256-8fba940250276020b724e776bc4ac5bbb2bd1e24d514aed0878defc1a0dd2ede",
      "manifest.yaml": "sha256-817ff4eeeb939cf7eedab8ffd80a905212fd9fd6ad9fc814a1ee3ee204785e41",
      "mdx/cases/c-socket-echo.mdx": "sha256-3f550af2e40965ea08d7544488d85d7860726ec3068cdff63d56e77f25c9f5c2",
      "mdx/cases/cuda-vector-add.mdx": "sha256-216544dd9d2ff20f320adf41742891848d31bc43204adcbba55da0212e09436c",
      "mdx/cases/mpi-first-message.mdx": "sha256-76d2a1f095280de62666ed7aaf424ef6f9a7222346a1940ef224c2310e8c5b4f",
      "mdx/cases/openmp-parallel-reduction.mdx": "sha256-8e7c302dfae3107da18d3db34301451d735332158e4a0c4c4906b52fe9b9cfef",
      "mdx/cases/ring-allreduce-simulator.mdx": "sha256-0f7c057c31d275e4cd508a536bd1e3ce19071c5c324226aa9e0502c5a7da631b",
      "mdx/lessons/find-slow-worker.zh-CN.mdx": "sha256-20982f3cb9a2c89b363d575a1d781e1a09542f87ccfdf4a09ce0364454606389",
      "scenarios/slow-worker-bandwidth-drop.v1.yaml": "sha256-4b7e265b7f02f17d38a97aab0d0c0de6313aa967b145401ff015f047ba82b75f"
    },
    "schemaVersion": "1.0.0",
    "supportedLocales": [
      "zh-CN",
      "en"
    ]
  },
  "scenarios": [
    {
      "causalModel": [
        {
          "from": "node03.network.bandwidth_gbps",
          "relation": "inverse",
          "to": "worker03.communication_time_ms"
        },
        {
          "from": "worker03.communication_time_ms",
          "relation": "increases",
          "to": "training.synchronization_wait_ms"
        },
        {
          "from": "training.synchronization_wait_ms",
          "relation": "increases",
          "to": "cluster.gpu_idle_ratio"
        },
        {
          "from": "training.synchronization_wait_ms",
          "relation": "increases",
          "to": "training.step_time_ms"
        },
        {
          "from": "training.step_time_ms",
          "relation": "inverse",
          "to": "training.throughput_samples_per_second"
        }
      ],
      "clock": "deterministic-virtual",
      "cluster": {
        "baselineNetworkGbps": 400,
        "disclosure": "Logical cluster state and metrics are SIMULATED / S2 and are not measurements of real NVIDIA hardware.",
        "gpuModel": "NVIDIA H100 SXM (SIMULATED)",
        "gpusPerNode": 8,
        "nodeCount": 16,
        "nodeNamePattern": "node%02d",
        "topology": "fat-tree",
        "totalGpuCount": 128
      },
      "events": [
        {
          "atSeconds": 40,
          "fault": {
            "id": "fault:node03-bandwidth",
            "kind": "network.bandwidth_drop",
            "parameters": {
              "fromGbps": 400,
              "toGbps": 20
            },
            "target": "node03"
          },
          "id": "event:activate-node03-bandwidth-fault",
          "type": "fault.activate"
        }
      ],
      "id": "scenario:slow-worker-bandwidth-drop",
      "job": {
        "baselineStepTimeMs": 180,
        "baselineThroughputSamplesPerSecond": 4551,
        "framework": "PyTorch DDP + NCCL (SIMULATED)",
        "id": "job:distributed-training-001",
        "name": "transformer-pretrain",
        "nodeCount": 16,
        "workersPerNode": 8
      },
      "minRuntimeVersion": "0.1.0-alpha.0",
      "requiredCapabilities": [
        "deterministic-clock",
        "simulated-nvidia-smi",
        "simulated-slurm",
        "causal-metrics-v1",
        "declarative-validator-v1"
      ],
      "seed": 240803,
      "simulationLevel": "S2",
      "title": "Node03 bandwidth degradation during synchronous training",
      "version": "1.0.0"
    }
  ]
} as unknown as RuntimeCurriculumProfile;

function required<T>(value: T | undefined, id: string): T {
  if (!value) throw new Error(`Generated curriculum snapshot is missing ${id}.`);
  return value;
}

export const findSlowWorkerScenario: ScenarioDefinition = required(
  runtimeCurriculumProfile.scenarios.find((item) => item.id === "scenario:slow-worker-bandwidth-drop" && item.version === "1.0.0"),
  "scenario:slow-worker-bandwidth-drop@1.0.0"
);

export const findSlowWorkerLab: LabDefinition = required(
  runtimeCurriculumProfile.labs.find((item) => item.id === "lab:find-slow-worker"),
  "lab:find-slow-worker"
);
