import type { EnvironmentDocument, ResolvedEntity, RuntimeCurriculumProfile, ScenarioDefinition, VersionedEntityId, VersionedReference } from "@infraenv/shared";

type Profile = RuntimeCurriculumProfile;
const canonicalCollections = ["accelerators", "systems", "fabrics", "bootProfiles", "presets", "scenarios", "lessonDocuments", "lessons", "labs"] as const;

export function versionedKey(reference: VersionedReference): VersionedEntityId {
  return `${reference.id}@${reference.version}`;
}

/** Indexes curriculum-owned canonical objects without redefining their schemas. */
export class CurriculumResolver {
  private readonly index = new Map<string, ResolvedEntity>();

  constructor(profile: Profile) {
    for (const collection of canonicalCollections) {
      const values = (profile as unknown as Record<string, unknown>)[collection];
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        if (!value || typeof value !== "object") continue;
        const record = value as Record<string, unknown>;
        if (typeof record.id !== "string") continue;
        const version = typeof record.version === "string" ? record.version : "1.0.0";
        const key = `${record.id}@${version}` as VersionedEntityId;
        this.index.set(key, { key, kind: collection, value: record, source: "curriculum" });
      }
    }
  }

  resolve<T = Record<string, unknown>>(reference: VersionedReference): ResolvedEntity<T> | undefined {
    return this.index.get(versionedKey(reference)) as ResolvedEntity<T> | undefined;
  }

  require<T = Record<string, unknown>>(reference: VersionedReference): ResolvedEntity<T> {
    const resolved = this.resolve<T>(reference);
    if (!resolved) throw new Error(`Curriculum entity ${versionedKey(reference)} was not found in the active profile.`);
    return resolved;
  }

  list(kind?: string): ResolvedEntity[] {
    const values = [...this.index.values()];
    return kind ? values.filter((value) => value.kind === kind) : values;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return value;
}

function reference(value: unknown, label: string): VersionedReference {
  const resolved = record(value, label);
  return { id: text(resolved.id, `${label}.id`), version: text(resolved.version, `${label}.version`) };
}

function canonical(profile: Profile, collection: string, ref: VersionedReference): Record<string, unknown> {
  const values = (profile as unknown as Record<string, unknown>)[collection];
  if (!Array.isArray(values)) throw new Error(`Curriculum profile has no ${collection} collection.`);
  const match = values.find((item) => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Record<string, unknown>;
    return candidate.id === ref.id && candidate.version === ref.version;
  });
  return record(match, `${collection}:${versionedKey(ref)}`);
}

/**
 * Resolves curriculum-owned Scenario -> Preset -> System/Fabric/Boot/Accelerator
 * documents into the stable course-v1 engine input. Canonical schemas stay in
 * the curriculum package; this adapter validates only fields it consumes.
 */
export function normalizeScenarioFromProfile(profile: Profile, value: Record<string, unknown>): ScenarioDefinition {
  if (value.simulationLevel !== "S2") throw new Error("Scenario compatibility requires simulationLevel S2.");
  const presetRef = reference(value.presetRef, "scenario.presetRef");
  const preset = canonical(profile, "presets", presetRef);
  if (preset.simulationLevel !== "S2") throw new Error("Resolved Preset must use simulationLevel S2.");
  const groups = preset.systemGroups;
  if (!Array.isArray(groups) || groups.length !== 1) throw new Error("The course-v1 compatibility engine requires one homogeneous system group.");
  const group = record(groups[0], "preset.systemGroups[0]");
  const systemRef = reference(group.systemRef, "systemGroup.systemRef");
  const system = canonical(profile, "systems", systemRef);
  const acceleratorRef = reference(system.acceleratorRef, "system.acceleratorRef");
  const accelerator = canonical(profile, "accelerators", acceleratorRef);
  const structure = record(system.structure, "system.structure");
  const acceleratorsPerUnit = finite(structure.acceleratorsPerComputeUnit, "structure.acceleratorsPerComputeUnit");
  const computeUnitCount = finite(structure.computeUnitCount, "structure.computeUnitCount");
  const memory = record(accelerator.memory, "accelerator.memory");
  const nvlink = accelerator.nvlink ? record(accelerator.nvlink, "accelerator.nvlink") : undefined;
  const fabrics = Array.isArray(preset.fabrics) ? preset.fabrics : [];
  const fabricInstance = fabrics[0] ? record(fabrics[0], "preset.fabrics[0]") : undefined;
  const fabricRef = fabricInstance ? reference(fabricInstance.fabricRef, "fabricInstance.fabricRef") : undefined;
  if (fabricRef) canonical(profile, "fabrics", fabricRef);
  const intraFabricRefs = Array.isArray(system.intraSystemFabricRefs) ? system.intraSystemFabricRefs.map((item, index) => reference(item, `system.intraSystemFabricRefs[${index}]`)) : [];
  const intraFabrics = intraFabricRefs.map((item) => canonical(profile, "fabrics", item));
  const acceleratorFabric = intraFabrics.find((item) => item.technology === "nvlink" || item.technology === "nvswitch");
  const pcieFabric = intraFabrics.find((item) => item.technology === "pcie");
  const topologyValue = fabricInstance?.topology;
  const topology = topologyValue === "ring" || topologyValue === "mesh" ? topologyValue : "fat-tree";
  const bootProfileRef = preset.bootProfileRef ? reference(preset.bootProfileRef, "preset.bootProfileRef") : undefined;
  if (bootProfileRef) canonical(profile, "bootProfiles", bootProfileRef);
  const scenarioEvents = Array.isArray(value.events) ? value.events : [];
  const causalModel = Array.isArray(value.causalModel) ? value.causalModel : [];
  const job = record(value.job, "scenario.job");
  const requiredCapabilities = Array.isArray(value.requiredCapabilities) ? value.requiredCapabilities.map((item) => text(item, "requiredCapability")) : [];
  const nodeCount = finite(group.count, "systemGroup.count");
  const gpusPerNode = acceleratorsPerUnit * computeUnitCount;
  const switchCount = finite(structure.switchesPerSwitchUnit ?? 0, "structure.switchesPerSwitchUnit") * finite(structure.switchUnitCount ?? 0, "structure.switchUnitCount");
  const topologyName = text(structure.intraSystemTopology, "structure.intraSystemTopology");
  const interconnectTopology = topologyName === "pcie-only" ? "pcie-only" : switchCount > 0 ? "switch" : "direct";

  return {
    id: text(value.id, "scenario.id"),
    version: text(value.version, "scenario.version"),
    title: text(value.title, "scenario.title"),
    seed: finite(value.seed, "scenario.seed"),
    minRuntimeVersion: text(value.minRuntimeVersion, "scenario.minRuntimeVersion"),
    requiredCapabilities,
    simulationLevel: "S2",
    clock: "deterministic-virtual",
    cluster: {
      nodeCount,
      nodeNamePattern: text(group.nodeNamePattern, "systemGroup.nodeNamePattern"),
      gpusPerNode,
      gpuModel: text(accelerator.model, "accelerator.model"),
      totalGpuCount: nodeCount * gpusPerNode,
      baselineNetworkGbps: fabricInstance ? finite(fabricInstance.capacityGbps, "fabricInstance.capacityGbps") : 1,
      topology,
      disclosure: text(preset.disclosure, "preset.disclosure"),
      acceleratorRef,
      systemRef,
      ...(bootProfileRef ? { bootProfileRef } : {}),
      ...(fabricRef ? { fabricRef } : {}),
      gpuMemoryMiB: finite(memory.hbmMiB, "accelerator.memory.hbmMiB"),
      gpuMemoryBandwidthGBps: finite(memory.theoreticalBandwidthGBps, "accelerator.memory.theoreticalBandwidthGBps"),
      gpuPowerLimitWatts: finite(accelerator.thermalDesignPowerWatts, "accelerator.thermalDesignPowerWatts"),
      ...(nvlink ? { gpuInterconnectBandwidthGBps: finite(nvlink.perAcceleratorBidirectionalGBps, "accelerator.nvlink.perAcceleratorBidirectionalGBps") } : {}),
      ...(acceleratorFabric?.generation ? { gpuInterconnectGeneration: text(acceleratorFabric.generation, "fabric.generation") } : {}),
      gpuInterconnectTopology: interconnectTopology,
      gpuInterconnectSwitchCount: switchCount,
      ...(pcieFabric?.generation ? { pcieGeneration: text(pcieFabric.generation, "pcieFabric.generation") } : {}),
      ...(pcieFabric?.theoreticalBandwidthGbps ? { pcieBandwidthGbps: finite(pcieFabric.theoreticalBandwidthGbps, "pcieFabric.theoreticalBandwidthGbps") } : {})
    },
    job: {
      id: text(job.id, "job.id"),
      name: text(job.name, "job.name"),
      framework: text(job.framework, "job.framework"),
      nodeCount: finite(job.nodeCount, "job.nodeCount"),
      workersPerNode: finite(job.workersPerNode, "job.workersPerNode"),
      baselineStepTimeMs: finite(job.baselineStepTimeMs, "job.baselineStepTimeMs"),
      baselineThroughputSamplesPerSecond: finite(job.baselineThroughputSamplesPerSecond, "job.baselineThroughputSamplesPerSecond")
    },
    events: structuredClone(scenarioEvents) as ScenarioDefinition["events"],
    causalModel: structuredClone(causalModel) as ScenarioDefinition["causalModel"]
  };
}

/** Course-v1 compatibility adapter retained until Environment assets land in the profile. */
export function environmentFromScenario(scenario: ScenarioDefinition, now = new Date().toISOString()): EnvironmentDocument {
  const nodes = Array.from({ length: scenario.cluster.nodeCount }, (_, rank) => ({
    id: scenario.cluster.nodeNamePattern.replace("%02d", rank.toString().padStart(2, "0")).replace("%d", String(rank)),
    roles: ["compute"] as Array<"compute">,
    cpuCores: 96,
    memoryGiB: 1024,
    accelerators: [{ id: "gpu", acceleratorRef: scenario.cluster.acceleratorRef ?? { id: "accelerator:compatibility-gpu", version: "1.0.0" }, count: scenario.cluster.gpusPerNode, memoryGiB: (scenario.cluster.gpuMemoryMiB ?? 81920) / 1024, ...(scenario.cluster.gpuMemoryBandwidthGBps ? { memoryBandwidthGBps: scenario.cluster.gpuMemoryBandwidthGBps } : {}), ...(scenario.cluster.gpuPowerLimitWatts ? { powerLimitWatts: scenario.cluster.gpuPowerLimitWatts } : {}), ...(scenario.cluster.gpuInterconnectBandwidthGBps ? { interconnectBandwidthGBps: scenario.cluster.gpuInterconnectBandwidthGBps } : {}), ...(scenario.cluster.gpuInterconnectGeneration ? { interconnectGeneration: scenario.cluster.gpuInterconnectGeneration } : {}), ...(scenario.cluster.gpuInterconnectTopology ? { interconnectTopology: scenario.cluster.gpuInterconnectTopology } : {}), ...(scenario.cluster.gpuInterconnectSwitchCount !== undefined ? { interconnectSwitchCount: scenario.cluster.gpuInterconnectSwitchCount } : {}), interconnect: scenario.cluster.gpuInterconnectTopology === "pcie-only" ? "pcie" as const : "nvlink" as const }],
    ...(scenario.cluster.systemRef ? { systemRef: scenario.cluster.systemRef } : {}),
    ...(scenario.cluster.bootProfileRef ? { bootProfileRef: scenario.cluster.bootProfileRef } : {}),
    ...(scenario.cluster.pcieGeneration ? { pcieGeneration: scenario.cluster.pcieGeneration } : {}),
    ...(scenario.cluster.pcieBandwidthGbps ? { pcieBandwidthGbps: scenario.cluster.pcieBandwidthGbps } : {})
  }));
  return {
    apiVersion: "infraenv.io/v1alpha1",
    kind: "Environment",
    metadata: { id: "environment:find-slow-worker", name: "Find Slow Worker compatibility environment", description: "Generated from the v1 course Scenario.", createdAt: now, updatedAt: now, labels: { "infraenv.dev/compatibility": "course-v1" } },
    spec: {
      simulationLevel: "S2",
      seed: scenario.seed,
      scenarioRef: { id: scenario.id, version: scenario.version },
      nodes,
      fabrics: [{ id: "cluster-fabric", ...(scenario.cluster.fabricRef ? { fabricRef: scenario.cluster.fabricRef } : {}), kind: scenario.cluster.topology === "fat-tree" ? "infiniband" : "custom", topology: scenario.cluster.topology, bandwidthGbps: scenario.cluster.baselineNetworkGbps, latencyMicroseconds: 2.5, endpointNodeIds: nodes.map((node) => node.id), oversubscriptionRatio: 1 }],
      storage: []
    }
  };
}
