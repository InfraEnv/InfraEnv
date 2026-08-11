import {
  SIMULATION_DISCLOSURE,
  createSessionId,
  type CommandResult,
  type FaultState,
  type GpuMetric,
  type NodeSnapshot,
  type ScenarioDefinition,
  type SimulationSnapshot,
  type TrainingMetric
} from "@infraenv/shared";
import { findSlowWorkerLab, findSlowWorkerRuntimeScenario } from "./scenario.js";

export interface EngineOptions {
  sessionId?: string;
  startTimeSeconds?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function seededNoise(seed: number, a: number, b: number): number {
  let x = (seed ^ Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b)) >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return (x >>> 0) / 0xffffffff;
}

export class SimulationEngine {
  readonly scenario: ScenarioDefinition;
  readonly sessionId: string;
  private virtualTimeSeconds: number;
  private revision = 1;
  private status: SimulationSnapshot["status"] = "running";
  private faultManuallyCleared = false;
  private faultManuallyInjected = false;
  private observations = { commands: [] as string[], inspectedNodes: [] as string[], metricGroups: [] as string[] };
  private hypothesis: { rootCause: string; target: string } | undefined;

  constructor(scenario = findSlowWorkerRuntimeScenario, options: EngineOptions = {}) {
    this.scenario = structuredClone(scenario);
    this.sessionId = options.sessionId ?? createSessionId();
    this.virtualTimeSeconds = options.startTimeSeconds ?? this.primaryEvent().atSeconds + 5;
  }

  pause(): SimulationSnapshot {
    this.status = "paused";
    this.revision += 1;
    return this.snapshot();
  }

  resume(): SimulationSnapshot {
    this.status = "running";
    this.revision += 1;
    return this.snapshot();
  }

  stop(): SimulationSnapshot {
    this.status = "stopped";
    this.revision += 1;
    return this.snapshot();
  }

  markPassed(): SimulationSnapshot {
    this.status = "passed";
    this.revision += 1;
    return this.snapshot();
  }

  reset(): SimulationSnapshot {
    this.virtualTimeSeconds = this.primaryEvent().atSeconds + 5;
    this.revision += 1;
    this.status = "running";
    this.faultManuallyCleared = false;
    this.faultManuallyInjected = false;
    this.observations = { commands: [], inspectedNodes: [], metricGroups: [] };
    this.hypothesis = undefined;
    return this.snapshot();
  }

  advance(seconds: number): SimulationSnapshot {
    if (this.status === "running") {
      this.virtualTimeSeconds += clamp(seconds, 0, 3600);
      this.revision += 1;
    }
    return this.snapshot();
  }

  injectFault(faultId: string): SimulationSnapshot {
    if (faultId !== this.primaryEvent().fault.id) throw new Error(`Fault ${faultId} is not allowed by this scenario.`);
    this.faultManuallyInjected = true;
    this.faultManuallyCleared = false;
    this.revision += 1;
    return this.snapshot();
  }

  clearFault(faultId: string): SimulationSnapshot {
    if (faultId !== this.primaryEvent().fault.id) throw new Error(`Unknown fault ${faultId}.`);
    this.faultManuallyCleared = true;
    this.faultManuallyInjected = false;
    this.revision += 1;
    return this.snapshot();
  }

  setHypothesis(rootCause: string, target: string): void {
    this.hypothesis = { rootCause, target };
    this.revision += 1;
  }

  observeCommand(command: string): void {
    const normalized = command.trim().replace(/^infraenv\s+/, "");
    if (!this.observations.commands.includes(normalized)) this.observations.commands.push(normalized);
    if (normalized.startsWith("inspect ")) {
      const node = normalized.split(/\s+/)[1];
      if (node && !this.observations.inspectedNodes.includes(node)) this.observations.inspectedNodes.push(node);
    }
    if (normalized.startsWith("metrics ")) {
      const group = normalized.split(/\s+/)[1];
      if (group && !this.observations.metricGroups.includes(group)) this.observations.metricGroups.push(group);
    }
    if (this.status === "running") this.virtualTimeSeconds += 2;
    this.revision += 1;
  }

  private isFaultActive(): boolean {
    if (this.faultManuallyCleared) return false;
    if (this.faultManuallyInjected) return true;
    return this.virtualTimeSeconds >= this.primaryEvent().atSeconds;
  }

  private primaryEvent(): ScenarioDefinition["events"][number] {
    const event = this.scenario.events[0];
    if (!event) throw new Error(`Scenario ${this.scenario.id} contains no fault event.`);
    return event;
  }

  private targetRank(): number {
    const match = /([0-9]+)$/.exec(this.primaryEvent().fault.target);
    if (!match) throw new Error(`Scenario target ${this.primaryEvent().fault.target} has no numeric rank.`);
    return Number.parseInt(match[1] ?? "0", 10);
  }

  private nodeId(rank: number): string {
    return this.scenario.cluster.nodeNamePattern.replace("%02d", rank.toString().padStart(2, "0")).replace("%d", String(rank));
  }

  private fault(): FaultState {
    const active = this.isFaultActive();
    const event = this.primaryEvent();
    const base: FaultState = {
      id: event.fault.id,
      type: event.fault.kind,
      target: event.fault.target,
      active,
      injectedAtSeconds: event.atSeconds
    };
    if (!active) base.clearedAtSeconds = this.virtualTimeSeconds;
    return base;
  }

  private gpuMetric(rank: number, index: number, faultActive: boolean): GpuMetric {
    const jitter = seededNoise(this.scenario.seed, rank, index);
    const targetRank = this.targetRank();
    const isSlowWorker = rank === targetRank && faultActive;
    const waitingForSlowWorker = rank !== targetRank && faultActive;
    const utilization = isSlowWorker ? 47 + jitter * 5 : waitingForSlowWorker ? 58 + jitter * 9 : 92 + jitter * 5;
    return {
      index,
      model: this.scenario.cluster.gpuModel,
      utilizationPercent: Number(utilization.toFixed(1)),
      memoryUsedMiB: Math.round((this.scenario.cluster.gpuMemoryMiB ?? 81920) * (0.83 + jitter * 0.02)),
      memoryTotalMiB: this.scenario.cluster.gpuMemoryMiB ?? 81920,
      temperatureC: Math.round(isSlowWorker ? 58 + jitter * 3 : 70 + jitter * 5),
      powerWatts: Math.round((this.scenario.cluster.gpuPowerLimitWatts ?? 700) * (isSlowWorker ? 0.58 + jitter * 0.03 : waitingForSlowWorker ? 0.66 + jitter * 0.04 : 0.92 + jitter * 0.04))
    };
  }

  private nodes(faultActive: boolean): NodeSnapshot[] {
    return Array.from({ length: this.scenario.cluster.nodeCount }, (_, rank) => {
      const id = this.nodeId(rank);
      const event = this.primaryEvent();
      const degraded = id === event.fault.target && faultActive;
      const jitter = seededNoise(this.scenario.seed, rank, 100);
      const bandwidth = degraded ? event.fault.parameters.toGbps : event.fault.parameters.fromGbps;
      return {
        id,
        rank,
        health: degraded ? "degraded" : "healthy",
        network: {
          bandwidthGbps: bandwidth,
          utilizationPercent: Number((degraded ? 98.4 : 72 + jitter * 7).toFixed(1)),
          latencyMs: Number((degraded ? 8.7 : 0.32 + jitter * 0.08).toFixed(2)),
          retransmitsPerSecond: Math.round(degraded ? 842 + jitter * 60 : jitter * 3)
        },
        gpus: Array.from({ length: this.scenario.cluster.gpusPerNode }, (_, index) => this.gpuMetric(rank, index, faultActive)),
        communicationWaitMs: Number((degraded ? 191.4 : faultActive ? 168 + jitter * 16 : 9 + jitter * 3).toFixed(1))
      };
    });
  }

  private training(faultActive: boolean): TrainingMetric {
    const event = this.primaryEvent();
    const severity = event.fault.parameters.fromGbps / event.fault.parameters.toGbps;
    const stepTimeMs = faultActive ? Number((this.scenario.job.baselineStepTimeMs * (1 + Math.log2(severity) * 0.2)).toFixed(1)) : this.scenario.job.baselineStepTimeMs;
    return {
      stepTimeMs,
      throughputSamplesPerSecond: Number((this.scenario.job.baselineThroughputSamplesPerSecond * this.scenario.job.baselineStepTimeMs / stepTimeMs).toFixed(1)),
      collectiveTimeMs: faultActive ? 218.6 : 31.2,
      synchronizationWaitMs: faultActive ? 174.3 : 8.9
    };
  }

  snapshot(): SimulationSnapshot {
    const faultActive = this.isFaultActive();
    const snapshot: SimulationSnapshot = {
      sessionId: this.sessionId,
      scenarioId: this.scenario.id,
      scenarioVersion: this.scenario.version,
      simulationLevel: "S2",
      allowedUiActions: [...findSlowWorkerLab.allowedUiActions],
      disclosure: SIMULATION_DISCLOSURE,
      seed: this.scenario.seed,
      virtualTimeSeconds: this.virtualTimeSeconds,
      revision: this.revision,
      status: this.status,
      nodes: this.nodes(faultActive),
      job: { ...structuredClone(this.scenario.job), state: "RUNNING", worldSize: this.scenario.cluster.totalGpuCount },
      training: this.training(faultActive),
      faults: [this.fault()],
      observations: structuredClone(this.observations)
    };
    if (this.hypothesis) snapshot.hypothesis = { ...this.hypothesis };
    return snapshot;
  }
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)));
  const render = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ");
  return [render(headers), render(widths.map((width) => "-".repeat(width))), ...rows.map(render)].join("\n");
}

export class CommandSimulator {
  constructor(readonly engine: SimulationEngine) {}

  execute(rawCommand: string): CommandResult {
    const command = rawCommand.trim();
    this.engine.observeCommand(command);
    const state = this.engine.snapshot();
    const normalized = command.replace(/^infraenv\s+/, "");
    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    if (command === "nvidia-smi") {
      stdout = this.nvidiaSmi(state);
    } else if (command === "sinfo") {
      stdout = `${SIMULATION_DISCLOSURE}\n${table(["PARTITION", "AVAIL", "TIMELIMIT", "STATE", "NODE"], state.nodes.map((node) => ["train*", "up", "infinite", node.health === "healthy" ? "idle~" : "mix~", node.id]))}`;
    } else if (command === "squeue") {
      stdout = `${SIMULATION_DISCLOSURE}\nJOBID PARTITION NAME USER ST TIME NODES WORLD_SIZE\n${state.job.id} train ${state.job.name} learner R 00:${Math.floor(state.virtualTimeSeconds).toString().padStart(2, "0")} ${state.job.nodeCount} ${state.job.worldSize}`;
    } else if (normalized === "nodes") {
      stdout = `${SIMULATION_DISCLOSURE}\n${table(["NODE", "HEALTH", "GPU", "LINK", "COMM_WAIT"], state.nodes.map((node) => [node.id, node.health, `${node.gpus.length}x ${node.gpus[0]?.model ?? "SIMULATED GPU"}`, `${node.network.bandwidthGbps} Gbps`, `${node.communicationWaitMs} ms`]))}`;
    } else if (normalized === "jobs") {
      stdout = `${SIMULATION_DISCLOSURE}\n${state.job.id} ${state.job.name} ${state.job.state} world_size=${state.job.worldSize} step=${state.training.stepTimeMs}ms throughput=${state.training.throughputSamplesPerSecond}/s`;
    } else if (normalized === "metrics network") {
      stdout = `${SIMULATION_DISCLOSURE}\n${table(["NODE", "BANDWIDTH", "UTIL", "LATENCY", "RETRANS/s"], state.nodes.map((node) => [node.id, `${node.network.bandwidthGbps} Gbps`, `${node.network.utilizationPercent}%`, `${node.network.latencyMs} ms`, String(node.network.retransmitsPerSecond)]))}`;
    } else if (normalized === "metrics gpu") {
      stdout = `${SIMULATION_DISCLOSURE}\n${table(["NODE", "GPU_UTIL(avg)", "COMM_WAIT", "SYMPTOM"], state.nodes.map((node) => [node.id, `${(node.gpus.reduce((sum, gpu) => sum + gpu.utilizationPercent, 0) / node.gpus.length).toFixed(1)}%`, `${node.communicationWaitMs} ms`, node.id === state.faults[0]?.target && node.health === "degraded" ? "local communication stall" : node.communicationWaitMs > 100 ? "waiting at collective" : "normal"]))}`;
    } else if (normalized.startsWith("inspect ")) {
      const nodeId = normalized.split(/\s+/)[1] ?? "";
      const node = state.nodes.find((item) => item.id === nodeId);
      if (!node) {
        stderr = `Unknown node: ${nodeId}`;
        exitCode = 2;
      } else {
        stdout = `${SIMULATION_DISCLOSURE}\nnode=${node.id}\nhealth=${node.health}\nlink=${node.network.bandwidthGbps} Gbps\nlatency=${node.network.latencyMs} ms\nretransmits=${node.network.retransmitsPerSecond}/s\ncommunication_wait=${node.communicationWaitMs} ms\nGPU utilization is a symptom; compare network and synchronization metrics before choosing a root cause.`;
      }
    } else if (normalized === "diagnose") {
      stdout = `${SIMULATION_DISCLOSURE}\nCorrelation report (not an answer):\n- Step time rises with collective time (r=0.96).\n- One worker has a strong network-bandwidth outlier.\n- Peers spend more time waiting at synchronization points.\nCandidate directions: network path, collective skew, host scheduling. Inspect the outlier across layers.`;
    } else {
      stderr = `Unsupported simulated command: ${command}\nAllowed: nvidia-smi, sinfo, squeue, infraenv nodes|jobs|metrics network|metrics gpu|inspect <node>|diagnose`;
      exitCode = 127;
    }

    return { command, stdout, stderr, exitCode, revision: this.engine.snapshot().revision };
  }

  private nvidiaSmi(state: SimulationSnapshot): string {
    const node = state.nodes[0];
    const rows = (node?.gpus ?? []).map((gpu) => [`${gpu.index}`, gpu.model, `${gpu.utilizationPercent}%`, `${gpu.memoryUsedMiB}/${gpu.memoryTotalMiB} MiB`, `${gpu.temperatureC}C`]);
    return `${SIMULATION_DISCLOSURE}\nLogical cluster: ${this.engine.scenario.cluster.nodeCount} nodes × ${this.engine.scenario.cluster.gpusPerNode} GPUs = ${this.engine.scenario.cluster.totalGpuCount} simulated accelerators\n${table(["GPU", "NAME", "UTIL", "MEMORY", "TEMP"], rows)}\nNote: this command reports ${state.nodes[0]?.id ?? "the current node"}; use 'infraenv metrics gpu' for the whole simulated cluster.`;
  }
}
