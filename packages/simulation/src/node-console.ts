import type {
  CommandResult,
  EnvironmentInstance,
  EnvironmentSnapshot,
  HardwareGraphEdge,
  HardwareGraphNode
} from "@infraenv/shared";

const DISCLOSURE = "SIMULATED / S2 — deterministic behavioral model; values are not measured hardware performance";

function table(headers: string[], values: string[][]): string {
  const widths = headers.map((header, index) => Math.max(header.length, ...values.map((row) => row[index]?.length ?? 0)));
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ");
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...values.map(line)].join("\n");
}

function numericSeed(seed: number, nodeId: string, index = 0): number {
  let value = seed >>> 0;
  for (const codePoint of nodeId) value = Math.imul(value ^ codePoint.codePointAt(0)!, 16777619) >>> 0;
  value ^= Math.imul(index + 1, 0x9e3779b1);
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

function modelName(device: HardwareGraphNode): string {
  const raw = String(device.attributes.model ?? "simulated-accelerator");
  return raw.startsWith("accelerator:") ? raw.slice("accelerator:".length).replaceAll("-", " ").toUpperCase() : raw;
}

function gpuUuid(seed: number, nodeId: string, index: number): string {
  const value = numericSeed(seed, nodeId, index).toString(16).padStart(8, "0");
  return `GPU-S2-${value}-${index.toString().padStart(2, "0")}`;
}

interface GpuRow {
  index: number;
  uuid: string;
  name: string;
  memoryTotalMiB: number;
  memoryUsedMiB: number;
  utilizationGpu: number;
  temperatureGpu: number;
  powerDraw: number;
  powerLimit: number;
}

export class NodeContextSimulator {
  private revision = 1;

  constructor(readonly snapshot: EnvironmentSnapshot, readonly instance: EnvironmentInstance, private nodeId = instance.activeNodeId) {
    this.assertNode(nodeId);
  }

  useNode(nodeId: string): void {
    this.assertNode(nodeId);
    this.nodeId = nodeId;
    this.revision += 1;
  }

  currentNode(): string { return this.nodeId; }

  execute(command: string): CommandResult {
    const normalized = command.trim().replace(/\s+/g, " ");
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      if (normalized === "nvidia-smi") stdout = this.nvidiaSmiSummary();
      else if (/^nvidia-smi -L$/.test(normalized)) stdout = this.nvidiaSmiList();
      else if (/^nvidia-smi -q(?: -i \d+)?$/.test(normalized)) stdout = this.nvidiaSmiQuery(normalized);
      else if (/^nvidia-smi --query-gpu=/.test(normalized)) stdout = this.nvidiaSmiCsv(normalized);
      else if (/^nvidia-smi topo -(m|mp|p2p)$/.test(normalized)) stdout = this.nvidiaTopology(normalized.split(" ").at(-1) ?? "-m");
      else if (/^nvidia-smi nvlink(?: -(s|c|e)| --(?:status|capabilities|error-counters))(?: -i \d+)?$/.test(normalized)) stdout = this.nvlinkQuery(normalized);
      else if (normalized === "nvitop" || normalized === "infraenv top") stdout = this.top();
      else if (normalized === "infraenv topology") stdout = this.topology();
      else if (/^infraenv bench(?: (hbm|p2p|collective|storage|all))?$/.test(normalized)) stdout = this.bench(normalized.split(" ")[2] ?? "all");
      else {
        stderr = `Unsupported S2 node command: ${normalized}. Run one of nvidia-smi, nvitop, infraenv top, infraenv topology, or infraenv bench.`;
        exitCode = 127;
      }
    } catch (error) {
      stderr = error instanceof Error ? error.message : String(error);
      exitCode = 2;
    }
    this.revision += 1;
    return { command: normalized, stdout, stderr, exitCode, revision: this.revision };
  }

  private system(): HardwareGraphNode { return this.assertNode(this.nodeId); }

  private accelerators(): HardwareGraphNode[] {
    return this.snapshot.graph.nodes
      .filter((node) => node.kind === "gpu" && (node.parentId === this.nodeId || node.id.startsWith(`${this.nodeId}/`)))
      .sort((left, right) => Number(left.attributes.index ?? 0) - Number(right.attributes.index ?? 0));
  }

  private gpuRows(): GpuRow[] {
    return this.accelerators().map((device, index) => {
      const roll = numericSeed(this.snapshot.document.spec.seed, this.nodeId, index);
      const memoryTotalMiB = Math.round(Number(device.attributes.memoryGiB ?? 0) * 1024);
      const powerLimit = Number(device.attributes.powerLimitWatts ?? 0) || 700;
      return {
        index,
        uuid: gpuUuid(this.snapshot.document.spec.seed, this.nodeId, index),
        name: modelName(device),
        memoryTotalMiB,
        memoryUsedMiB: Math.min(memoryTotalMiB, Math.round(memoryTotalMiB * (0.41 + (roll % 23) / 100))),
        utilizationGpu: 64 + roll % 27,
        temperatureGpu: 49 + roll % 24,
        powerDraw: Math.round(powerLimit * (0.68 + (roll % 24) / 100)),
        powerLimit
      };
    });
  }

  private nvidiaSmiSummary(): string {
    const rows = this.gpuRows();
    const output = table(
      ["GPU", "NAME", "MEMORY", "GPU-UTIL", "TEMP", "POWER"],
      rows.map((row) => [String(row.index), row.name, `${row.memoryUsedMiB}/${row.memoryTotalMiB} MiB`, `${row.utilizationGpu}%`, `${row.temperatureGpu} C`, `${row.powerDraw}/${row.powerLimit} W`])
    );
    return `${DISCLOSURE}\nnode=${this.nodeId} seed=${this.snapshot.document.spec.seed}\n${output}${rows.length ? "" : "\nNo simulated accelerators on this node."}`;
  }

  private nvidiaSmiList(): string {
    const lines = this.gpuRows().map((row) => `GPU ${row.index}: ${row.name} (UUID: ${row.uuid})`);
    return `${DISCLOSURE}\n${lines.length ? lines.join("\n") : "No simulated accelerators found."}`;
  }

  private nvidiaSmiQuery(command: string): string {
    const indexMatch = command.match(/ -i (\d+)$/);
    const selected = indexMatch ? this.gpuRows().filter((row) => row.index === Number(indexMatch[1])) : this.gpuRows();
    if (indexMatch && selected.length === 0) throw new Error(`GPU index ${indexMatch[1]} is not present on ${this.nodeId}.`);
    const sections = selected.map((row) => [
      `GPU ${row.index}`,
      `    Product Name                    : ${row.name}`,
      `    GPU UUID                        : ${row.uuid}`,
      `    FB Memory Usage`,
      `        Total                      : ${row.memoryTotalMiB} MiB`,
      `        Used                       : ${row.memoryUsedMiB} MiB`,
      `    Utilization`,
      `        Gpu                        : ${row.utilizationGpu} %`,
      `    Temperature`,
      `        GPU Current Temp           : ${row.temperatureGpu} C`,
      `    Power Readings`,
      `        Power Draw                 : ${row.powerDraw} W`,
      `        Power Limit                : ${row.powerLimit} W`
    ].join("\n"));
    return `${DISCLOSURE}\nseed=${this.snapshot.document.spec.seed}\n${sections.join("\n\n")}`;
  }

  private nvidiaSmiCsv(command: string): string {
    const match = command.match(/^nvidia-smi --query-gpu=([^ ]+)(?: --format=([^ ]+))?$/);
    if (!match) throw new Error("Use --query-gpu=<field,...> followed by an optional --format=csv[,noheader][,nounits].");
    const fields = (match[1] ?? "").split(",");
    const format = new Set((match[2] ?? "csv").split(","));
    if (!format.has("csv")) throw new Error("Only CSV query output is supported by the S2 model.");
    const supported: Record<string, (row: GpuRow) => string> = {
      index: (row) => String(row.index),
      uuid: (row) => row.uuid,
      name: (row) => row.name,
      "memory.total": (row) => format.has("nounits") ? String(row.memoryTotalMiB) : `${row.memoryTotalMiB} MiB`,
      "memory.used": (row) => format.has("nounits") ? String(row.memoryUsedMiB) : `${row.memoryUsedMiB} MiB`,
      "utilization.gpu": (row) => format.has("nounits") ? String(row.utilizationGpu) : `${row.utilizationGpu} %`,
      "temperature.gpu": (row) => format.has("nounits") ? String(row.temperatureGpu) : `${row.temperatureGpu} C`,
      "power.draw": (row) => format.has("nounits") ? String(row.powerDraw) : `${row.powerDraw} W`
    };
    for (const field of fields) if (!supported[field]) throw new Error(`Unsupported --query-gpu field: ${field}.`);
    const rows = this.gpuRows().map((row) => fields.map((field) => supported[field]!(row)).join(", "));
    if (!format.has("noheader")) rows.unshift(fields.join(", "));
    return `${DISCLOSURE}\n${rows.join("\n")}`;
  }

  private nvidiaTopology(mode: string): string {
    const rows = this.gpuRows();
    const headers = ["GPU", ...rows.map((row) => `GPU${row.index}`), "CPU Affinity", "NUMA Affinity"];
    const values = rows.map((row) => [
      `GPU${row.index}`,
      ...rows.map((peer) => row.index === peer.index ? "X" : Math.floor(row.index / 4) === Math.floor(peer.index / 4) ? "NV18" : mode === "-p2p" ? "OK" : "SYS"),
      `${Math.floor(row.index / 4) * 24}-${Math.floor(row.index / 4) * 24 + 23}`,
      String(Math.floor(row.index / 4))
    ]);
    return `${DISCLOSURE}\nmode=${mode} node=${this.nodeId}\n${table(headers, values)}\nLegend: X=self NV18=modeled NVLink path SYS=modeled cross-NUMA path OK=P2P modeled available`;
  }

  private nvlinkQuery(command: string): string {
    const rows = this.gpuRows();
    const mode = command.includes("capabilities") || command.includes(" -c") ? "capabilities" : command.includes("error") || command.includes(" -e") ? "error-counters" : "status";
    const linksPerGpu = Math.max(0, Math.min(18, rows.length - 1));
    const detail = rows.map((row) => {
      if (mode === "capabilities") return `GPU ${row.index}: links=${linksPerGpu}, p2p=true, atomics=true, coherent=false`;
      if (mode === "error-counters") return `GPU ${row.index}: replay=0, recovery=0, crc_flit=0, crc_data=0`;
      return `GPU ${row.index}: ${linksPerGpu} modeled links active, health=healthy`;
    });
    return `${DISCLOSURE}\nNVLink ${mode}; seed=${this.snapshot.document.spec.seed}\n${detail.join("\n")}`;
  }

  private top(): string {
    const system = this.system();
    const devices = this.gpuRows();
    const processes = devices.slice(0, 4).map((gpu, index) => [`${11000 + index}`, `worker-${index}`, `GPU${gpu.index}`, `${gpu.utilizationGpu}%`, `${gpu.memoryUsedMiB} MiB`]);
    return `${DISCLOSURE}\nINFRAENV TOP — ${this.nodeId}\nCPU ${system.attributes.cpuCores} cores | memory ${system.attributes.memoryGiB} GiB | GPUs ${devices.length}\nstep=${this.snapshot.performance.estimatedStepTimeMs} ms throughput=${this.snapshot.performance.estimatedThroughputSamplesPerSecond}/s bottleneck=${this.snapshot.performance.bottleneck}\n${table(["PID", "PROCESS", "DEVICE", "UTIL", "GPU MEMORY"], processes)}`;
  }

  private relevantEdges(): HardwareGraphEdge[] {
    const descendants = new Set(this.snapshot.graph.nodes.filter((node) => node.parentId === this.nodeId || node.id.startsWith(`${this.nodeId}/`)).map((node) => node.id));
    descendants.add(this.nodeId);
    return this.snapshot.graph.edges.filter((edge) => descendants.has(edge.source) || descendants.has(edge.target));
  }

  private topology(): string {
    const connected = this.relevantEdges();
    return `${DISCLOSURE}\nTOPOLOGY — ${this.nodeId}\n${table(["EDGE", "KIND", "FROM", "TO", "GEN", "BANDWIDTH", "HEALTH"], connected.map((edge) => [edge.id, edge.kind, edge.source, edge.target, edge.generation ?? "-", edge.bandwidthGbps ? `${edge.bandwidthGbps} Gbps` : "modeled", edge.health]))}`;
  }

  private bench(group: string): string {
    const result = this.snapshot.performance;
    const gpuCount = Math.max(1, this.accelerators().length);
    const hbmTheory = this.accelerators().reduce((sum, gpu) => sum + Number(gpu.attributes.memoryBandwidthGBps ?? 0), 0);
    const hbmModel = hbmTheory * 0.78;
    const modeledLinks = this.accelerators().map((gpu) => Number(gpu.attributes.interconnectBandwidthGBps ?? 0)).filter((value) => value > 0);
    const p2pTheory = gpuCount > 1 && modeledLinks.length ? Math.min(...modeledLinks) : 64;
    const p2pModel = p2pTheory * 0.74;
    const storageTheory = this.snapshot.document.spec.storage.reduce((sum, storage) => sum + storage.readBandwidthGbps, 0);
    const blocks: string[] = [`${DISCLOSURE}\nbenchmark=${group} seed=${result.seed} confidence=${result.confidence}`];
    if (group === "hbm" || group === "all") blocks.push(`hbm.theory=${hbmTheory.toFixed(2)} GB/s\nhbm.model=${hbmModel.toFixed(2)} GB/s`);
    if (group === "p2p" || group === "all") blocks.push(`p2p.theory=${p2pTheory.toFixed(2)} GB/s\np2p.model=${p2pModel.toFixed(2)} GB/s`);
    if (group === "collective" || group === "all") blocks.push(`collective.theory=${this.snapshot.document.spec.fabrics[0]?.bandwidthGbps ?? 0} Gbps\ncollective.model=${result.effectiveNetworkGbps} Gbps\ncollective.latency.model=${result.collectiveLatencyMs} ms`);
    if (group === "storage" || group === "all") blocks.push(`storage.theory=${storageTheory.toFixed(2)} Gbps\nstorage.model=${(storageTheory * 0.71).toFixed(2)} Gbps`);
    blocks.push(`assumptions=steady-state, healthy links, synthetic load, no thermal throttling\nbottleneck=${result.bottleneck}`);
    return blocks.join("\n");
  }

  private assertNode(nodeId: string): HardwareGraphNode {
    const node = this.snapshot.graph.nodes.find((candidate) => candidate.id === nodeId && candidate.kind === "node");
    if (!node) throw new Error(`Node ${nodeId} is not present in snapshot ${this.snapshot.metadata.id}.`);
    return node;
  }
}
