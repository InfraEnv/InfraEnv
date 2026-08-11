import type {
  BootModelResult,
  EnvironmentDocument,
  HardwareGraph,
  HardwareGraphEdge,
  HardwareGraphNode,
  PerformanceModelResult
} from "@infraenv/shared";
import { MAX_PLAYGROUND_LOGICAL_GPUS } from "@infraenv/shared";

function deterministicUnit(seed: number, salt: number): number {
  let value = (seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 0xffffffff;
}

function safeEnvironmentName(id: string): string {
  return id.slice(id.indexOf(":") + 1).replace(/[^a-z0-9-]/g, "-");
}

/**
 * Expands the compact local Environment document into an inspectable graph.
 * Canonical hardware metadata remains curriculum-owned; this resolver only
 * creates stable local containment and connectivity nodes around references.
 */
export function parseHardwareGraph(document: EnvironmentDocument): HardwareGraph {
  const nodes: HardwareGraphNode[] = [];
  const edges: HardwareGraphEdge[] = [];
  const expanded = new Map<string, string[]>();
  const systemIds = new Set<string>();
  const knownNodeIds = new Set<string>();
  const nodeNicIds = new Map<string, string>();
  let acceleratorTotal = 0;
  let cpuTotal = 0;
  let memoryTotal = 0;

  const addNode = (node: HardwareGraphNode): void => {
    if (knownNodeIds.has(node.id)) throw new Error(`Duplicate hardware graph node ${node.id}.`);
    knownNodeIds.add(node.id);
    nodes.push(node);
  };
  const addEdge = (edge: HardwareGraphEdge): void => { edges.push(edge); };

  const declaredSystemCount = document.spec.nodes.reduce((sum, template) => sum + (template.count ?? 1), 0);
  const declaredAcceleratorCount = document.spec.nodes.reduce((sum, template) => sum + (template.count ?? 1) * template.accelerators.reduce((gpuSum, attachment) => gpuSum + attachment.count, 0), 0);
  if (!Number.isSafeInteger(declaredSystemCount) || declaredSystemCount < 1 || declaredSystemCount > 1024) throw new Error(`Environment expands to ${declaredSystemCount} nodes; the S2 model limit is 1024.`);
  if (!Number.isSafeInteger(declaredAcceleratorCount) || declaredAcceleratorCount < 0 || declaredAcceleratorCount > MAX_PLAYGROUND_LOGICAL_GPUS) throw new Error(`Environment expands to ${declaredAcceleratorCount} accelerators; the S2 model limit is ${MAX_PLAYGROUND_LOGICAL_GPUS}.`);
  const clusterId = `cluster:${safeEnvironmentName(document.metadata.id)}`;
  addNode({ id: clusterId, kind: "cluster", attributes: { name: document.metadata.name, simulationLevel: "S2", seed: document.spec.seed } });
  const requestedRackCount = document.spec.placement?.rackCount;
  const nodesPerRack = document.spec.placement?.nodesPerRack ?? (requestedRackCount ? Math.ceil(declaredSystemCount / requestedRackCount) : declaredSystemCount);
  if (requestedRackCount && requestedRackCount * nodesPerRack < declaredSystemCount) throw new Error("Environment placement does not have enough rack capacity for all nodes.");

  let globalNodeIndex = 0;
  for (const template of document.spec.nodes) {
    const count = template.count ?? 1;
    const nodeIds = Array.from({ length: count }, (_, index) => count === 1 ? template.id : `${template.id}-${index.toString().padStart(2, "0")}`);
    expanded.set(template.id, nodeIds);
    for (const nodeId of nodeIds) {
      if (systemIds.has(nodeId)) throw new Error(`Duplicate Environment node ${nodeId}.`);
      systemIds.add(nodeId);
      const rackIndex = Math.floor(globalNodeIndex / nodesPerRack);
      const rackId = `${clusterId}/rack${rackIndex.toString().padStart(2, "0")}`;
      if (!knownNodeIds.has(rackId)) {
        addNode({ id: rackId, kind: "rack", parentId: clusterId, attributes: { index: rackIndex, modeledCapacityNodes: nodesPerRack, placementSource: document.spec.placement ? "environment" : "single-rack-default" } });
        addEdge({ id: `contains:${clusterId}:${rackId}`, source: clusterId, target: rackId, kind: "ethernet", relation: "contains", direction: "bidirectional", generation: "management", health: "healthy" });
      }
      const chassisId = `${nodeId}/chassis0`;
      addNode({ id: chassisId, kind: "chassis", parentId: rackId, attributes: { slot: globalNodeIndex % nodesPerRack } });
      addEdge({ id: `contains:${rackId}:${chassisId}`, source: rackId, target: chassisId, kind: "ethernet", relation: "contains", direction: "bidirectional", generation: "management", health: "healthy" });

      addNode({ id: nodeId, kind: "node", parentId: chassisId, attributes: { cpuCores: template.cpuCores, memoryGiB: template.memoryGiB, roles: template.roles.join(","), systemRef: template.systemRef ? `${template.systemRef.id}@${template.systemRef.version}` : "inline" } });
      addEdge({ id: `contains:${chassisId}:${nodeId}`, source: chassisId, target: nodeId, kind: "ethernet", relation: "contains", direction: "bidirectional", generation: "management", health: "healthy" });

      const numaCount = template.cpuCores >= 64 ? 2 : 1;
      for (let numa = 0; numa < numaCount; numa += 1) {
        const numaId = `${nodeId}/numa${numa}`;
        addNode({ id: numaId, kind: "cpu-numa", parentId: nodeId, attributes: { index: numa, cpuCores: Math.floor(template.cpuCores / numaCount), memoryGiB: template.memoryGiB / numaCount } });
        addEdge({ id: `pcie:${nodeId}:${numaId}`, source: nodeId, target: numaId, kind: "pcie", relation: "contains", direction: "bidirectional", generation: "CPU interconnect", health: "healthy" });
      }
      const memoryId = `${nodeId}/memory0`;
      addNode({ id: memoryId, kind: "memory", parentId: nodeId, attributes: { capacityGiB: template.memoryGiB, technology: "modeled-system-memory" } });
      addEdge({ id: `pcie:${nodeId}:${memoryId}`, source: nodeId, target: memoryId, kind: "pcie", relation: "contains", direction: "bidirectional", generation: "memory-bus", health: "healthy" });

      const pcieRootId = `${nodeId}/pcie-root0`;
      const pcieSwitchId = `${nodeId}/pcie-switch0`;
      const pcieGeneration = template.pcieGeneration ?? "unspecified";
      const pcieBandwidthGbps = template.pcieBandwidthGbps ?? 1;
      addNode({ id: pcieRootId, kind: "pcie-root", parentId: nodeId, attributes: { generation: pcieGeneration, disclosure: template.pcieGeneration ? "resolved" : "unspecified-s2-assumption" } });
      addNode({ id: pcieSwitchId, kind: "pcie-switch", parentId: pcieRootId, attributes: { generation: pcieGeneration, sharedGroup: `${nodeId}-pcie` } });
      addEdge({ id: `pcie:${nodeId}:${pcieRootId}`, source: nodeId, target: pcieRootId, kind: "pcie", relation: "contains", direction: "bidirectional", generation: pcieGeneration, bandwidthGbps: pcieBandwidthGbps, health: "healthy" });
      addEdge({ id: `pcie:${pcieRootId}:${pcieSwitchId}`, source: pcieRootId, target: pcieSwitchId, kind: "pcie", relation: "connects", direction: "bidirectional", generation: pcieGeneration, sharedGroup: `${nodeId}-pcie`, bandwidthGbps: pcieBandwidthGbps, health: "healthy" });

      const switchCount = Math.max(0, ...template.accelerators.map((attachment) => attachment.interconnectTopology === "switch" ? attachment.interconnectSwitchCount ?? 1 : 0));
      const nvSwitchIds = Array.from({ length: switchCount }, (_, index) => `${nodeId}/nvswitch${index}`);
      for (const nvSwitchId of nvSwitchIds) {
        const generation = template.accelerators.find((attachment) => attachment.interconnectTopology === "switch")?.interconnectGeneration ?? "unspecified";
        addNode({ id: nvSwitchId, kind: "nvswitch", parentId: nodeId, attributes: { generation, modeledPorts: template.accelerators.reduce((sum, attachment) => sum + attachment.count, 0) } });
        addEdge({ id: `pcie:${pcieRootId}:${nvSwitchId}`, source: pcieRootId, target: nvSwitchId, kind: "pcie", relation: "connects", direction: "bidirectional", generation: pcieGeneration, bandwidthGbps: pcieBandwidthGbps, health: "healthy" });
      }

      let acceleratorIndex = 0;
      const directAcceleratorIds: Array<{ id: string; attachment: EnvironmentDocument["spec"]["nodes"][number]["accelerators"][number] }> = [];
      for (const attachment of template.accelerators) {
        for (let gpu = 0; gpu < attachment.count; gpu += 1) {
          const acceleratorId = `${nodeId}/${attachment.id}${gpu}`;
          addNode({ id: acceleratorId, kind: "gpu", parentId: pcieSwitchId, attributes: { model: attachment.acceleratorRef.id, version: attachment.acceleratorRef.version, memoryGiB: attachment.memoryGiB ?? 0, peakTflops: attachment.peakTflops ?? 100, memoryBandwidthGBps: attachment.memoryBandwidthGBps ?? 0, powerLimitWatts: attachment.powerLimitWatts ?? 0, interconnectBandwidthGBps: attachment.interconnectBandwidthGBps ?? 0, interconnect: attachment.interconnect ?? "pcie", index: acceleratorIndex } });
          addEdge({ id: `pcie:${pcieSwitchId}:${acceleratorId}`, source: pcieSwitchId, target: acceleratorId, kind: "pcie", relation: "connects", direction: "bidirectional", generation: pcieGeneration, sharedGroup: `${nodeId}-pcie`, bandwidthGbps: pcieBandwidthGbps, health: "healthy" });
          if (attachment.interconnectTopology === "switch" && nvSwitchIds.length > 0) {
            const nvSwitchId = nvSwitchIds[acceleratorIndex % nvSwitchIds.length]!;
            addEdge({ id: `accelerator-link:${nvSwitchId}:${acceleratorId}`, source: nvSwitchId, target: acceleratorId, kind: attachment.interconnect === "xgmi" ? "nvlink-c2c" : "nvlink", relation: "connects", direction: "bidirectional", generation: attachment.interconnectGeneration ?? "unspecified", sharedGroup: `${nodeId}-accelerator-fabric`, bandwidthGbps: attachment.interconnectBandwidthGBps ?? 1, health: "healthy" });
          } else if (attachment.interconnectTopology === "direct") directAcceleratorIds.push({ id: acceleratorId, attachment });
          acceleratorIndex += 1;
          acceleratorTotal += 1;
        }
      }
      for (let index = 1; index < directAcceleratorIds.length; index += 1) {
        const left = directAcceleratorIds[index - 1]!;
        const right = directAcceleratorIds[index]!;
        addEdge({ id: `accelerator-direct:${left.id}:${right.id}`, source: left.id, target: right.id, kind: left.attachment.interconnect === "xgmi" ? "nvlink-c2c" : "nvlink", relation: "connects", direction: "bidirectional", generation: left.attachment.interconnectGeneration ?? "unspecified", sharedGroup: `${nodeId}-accelerator-direct`, bandwidthGbps: left.attachment.interconnectBandwidthGBps ?? 1, health: "healthy" });
      }

      const nicId = `${nodeId}/nic0`;
      nodeNicIds.set(nodeId, nicId);
      addNode({ id: nicId, kind: "nic-dpu", parentId: pcieRootId, attributes: { generation: "resolved-by-cluster-fabric", ports: 1 } });
      addEdge({ id: `pcie:${pcieRootId}:${nicId}`, source: pcieRootId, target: nicId, kind: "pcie", relation: "connects", direction: "bidirectional", generation: pcieGeneration, sharedGroup: `${nodeId}-pcie`, bandwidthGbps: pcieBandwidthGbps, health: "healthy" });

      cpuTotal += template.cpuCores;
      memoryTotal += template.memoryGiB;
      globalNodeIndex += 1;
    }
  }

  const expand = (ids: string[]) => ids.flatMap((id) => expanded.get(id) ?? [id]);
  for (const fabric of document.spec.fabrics) {
    const fabricId = `fabric:${fabric.id}`;
    addNode({ id: fabricId, kind: "fabric-switch", parentId: clusterId, attributes: { kind: fabric.kind, topology: fabric.topology, bandwidthGbps: fabric.bandwidthGbps, latencyMicroseconds: fabric.latencyMicroseconds } });
    const linkKind: HardwareGraphEdge["kind"] = fabric.kind === "infiniband" ? "infiniband" : fabric.kind === "ethernet" ? "ethernet" : fabric.kind === "nvlink" ? "nvlink" : fabric.kind === "xgmi" ? "nvlink-c2c" : "roce";
    for (const endpoint of expand(fabric.endpointNodeIds)) {
      if (!systemIds.has(endpoint)) throw new Error(`Fabric ${fabric.id} references unknown node ${endpoint}.`);
      addEdge({ id: `fabric:${fabric.id}:${endpoint}`, source: nodeNicIds.get(endpoint) ?? endpoint, target: fabricId, kind: linkKind, relation: "connects", direction: "bidirectional", generation: fabric.fabricRef ? `${fabric.fabricRef.id}@${fabric.fabricRef.version}` : "inline", sharedGroup: fabric.id, oversubscriptionRatio: fabric.oversubscriptionRatio ?? 1, health: "healthy", bandwidthGbps: fabric.bandwidthGbps / (fabric.oversubscriptionRatio ?? 1), latencyMicroseconds: fabric.latencyMicroseconds });
    }
  }

  let storageTotal = 0;
  for (const storage of document.spec.storage) {
    const storageId = `storage:${storage.id}`;
    addNode({ id: storageId, kind: "storage-endpoint", parentId: clusterId, attributes: { kind: storage.kind, capacityGiB: storage.capacityGiB, readBandwidthGbps: storage.readBandwidthGbps, writeBandwidthGbps: storage.writeBandwidthGbps } });
    storageTotal += storage.capacityGiB;
    for (const endpoint of expand(storage.endpointNodeIds)) {
      if (!systemIds.has(endpoint)) throw new Error(`Storage ${storage.id} references unknown node ${endpoint}.`);
      addEdge({ id: `storage:${storage.id}:${endpoint}`, source: nodeNicIds.get(endpoint) ?? endpoint, target: storageId, kind: "storage-network", relation: "mounts", direction: "bidirectional", generation: storage.kind, sharedGroup: storage.id, health: "healthy", bandwidthGbps: storage.readBandwidthGbps });
    }
  }

  return { environmentId: document.metadata.id, nodes, edges, totals: { systems: systemIds.size, accelerators: acceleratorTotal, cpuCores: cpuTotal, memoryGiB: memoryTotal, storageGiB: storageTotal } };
}

export function modelBoot(document: EnvironmentDocument, graph = parseHardwareGraph(document)): BootModelResult {
  const jitter = (salt: number, amplitude: number) => Math.round(deterministicUnit(document.spec.seed, salt) * amplitude);
  const phases: BootModelResult["phases"] = [
    { name: "allocate", milliseconds: 300 + graph.totals.systems * 35 + jitter(1, 80) },
    { name: "network", milliseconds: 200 + document.spec.fabrics.length * 120 + graph.totals.systems * 8 + jitter(2, 60) },
    { name: "storage", milliseconds: 150 + document.spec.storage.length * 90 + jitter(3, 50) },
    { name: "runtime", milliseconds: 700 + graph.totals.accelerators * 4 + jitter(4, 120) },
    { name: "workload", milliseconds: 500 + Math.ceil(graph.totals.accelerators / 8) * 25 + jitter(5, 100) }
  ];
  const warnings: string[] = [];
  if (graph.totals.accelerators === 0) warnings.push("Environment has no accelerators; GPU commands will report no devices.");
  if (document.spec.fabrics.length === 0 && graph.totals.systems > 1) warnings.push("Multi-node environment has no explicit fabric.");
  return { seed: document.spec.seed, totalMilliseconds: phases.reduce((sum, phase) => sum + phase.milliseconds, 0), phases, warnings };
}

export function modelPerformance(document: EnvironmentDocument, graph = parseHardwareGraph(document)): PerformanceModelResult {
  const accelerators = graph.nodes.filter((node) => node.kind === "gpu");
  const theoreticalCompute = accelerators.reduce((sum, node) => sum + Number(node.attributes.peakTflops ?? 100), 0);
  const effectiveComputeTflops = theoreticalCompute * (0.54 + deterministicUnit(document.spec.seed, 20) * 0.12);
  const fabricEdges = graph.edges.filter((edge) => ["infiniband", "roce", "ethernet"].includes(edge.kind) && edge.relation === "connects");
  const effectiveNetworkGbps = fabricEdges.length ? Math.min(...fabricEdges.map((edge) => edge.bandwidthGbps ?? 1)) * (0.72 + deterministicUnit(document.spec.seed, 21) * 0.12) : 1;
  const storageBandwidth = document.spec.storage.reduce((sum, item) => sum + item.readBandwidthGbps, 0);
  const collectiveLatencyMs = graph.totals.systems <= 1 ? 0.08 : Number(((Math.log2(graph.totals.systems) + 1) * (1000 / effectiveNetworkGbps)).toFixed(3));
  const computeStepMs = effectiveComputeTflops > 0 ? 80000 / effectiveComputeTflops : 10000;
  const networkStepMs = collectiveLatencyMs * Math.max(1, Math.log2(Math.max(2, graph.totals.accelerators)));
  const storageStepMs = storageBandwidth > 0 ? 400 / storageBandwidth : 10000;
  const estimatedStepTimeMs = Number((computeStepMs + networkStepMs + storageStepMs).toFixed(3));
  const pressures = { compute: computeStepMs, network: networkStepMs, storage: storageStepMs, memory: graph.totals.memoryGiB > 0 ? graph.totals.accelerators * 80 / graph.totals.memoryGiB * 10 : 10000 };
  const bottleneck = (Object.entries(pressures).sort((left, right) => right[1] - left[1])[0]?.[0] ?? "compute") as PerformanceModelResult["bottleneck"];
  return {
    seed: document.spec.seed,
    effectiveComputeTflops: Number(effectiveComputeTflops.toFixed(2)),
    effectiveNetworkGbps: Number(effectiveNetworkGbps.toFixed(2)),
    collectiveLatencyMs,
    estimatedStepTimeMs,
    estimatedThroughputSamplesPerSecond: Number((8192 / (estimatedStepTimeMs / 1000)).toFixed(2)),
    bottleneck,
    confidence: "behavioral-s2",
    disclosure: "SIMULATED / S2 — deterministic capacity model, not a real benchmark"
  };
}
